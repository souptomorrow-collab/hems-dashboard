# -*- coding: utf-8 -*-
"""
抓展示用日期的台北實際天氣（open-meteo ERA5 再分析資料），存成 public/data/weather.json。

為什麼要這支：
    UI 上的太陽能曲線是資料集那天（2010 年）的 LSTM 預測，但天氣原本是依「今天的日期」
    亂數模擬的，常常出現「天氣條寫下大雨、太陽能卻發滿」的矛盾。發電量預測的輸入
    本來就來自 open-meteo 的 ERA5（見 負載預測2/PV_介面/fetch_pv_inputs.py），這裡抓
    同一個來源、同一個地點、同一天，天氣和發電量才對得起來。

日期從 public/data/history.json 讀，和歷史紀錄頁用到的日子保持一致；不需要資料庫連線。

執行：python scripts/fetch_weather.py

時間戳的對齊（和 fetch_pv_inputs.py 驗證過的一樣）：
    氣溫、濕度、雲量是「整點的瞬間值」→ 第 h 小時取 h 與 h+1 兩個整點的平均
    降雨量、日射量是「前一小時的累積／平均」→ 第 h 小時取 h+1 那筆
"""
import os
import argparse
import json
import urllib.request
from datetime import date, timedelta

LAT, LON = 25.033, 121.5654          # 台北，和發電量預測的輸入同一點
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(HERE), "public", "data")
VARS = ["temperature_2m", "relative_humidity_2m", "cloud_cover", "precipitation",
        "shortwave_radiation", "terrestrial_radiation"]


def spans(days):
    """把日期併成連續區段，一段抓一次；每段多抓隔天 00:00，最後一小時才有 h+1。"""
    days = sorted(days)
    out, start, prev = [], days[0], days[0]
    for d in days[1:]:
        if d - prev > timedelta(days=1):
            out.append((start, prev))
            start = d
        prev = d
    out.append((start, prev))
    return out


def fetch(a, b):
    url = ("https://archive-api.open-meteo.com/v1/archive"
           f"?latitude={LAT}&longitude={LON}&start_date={a}&end_date={b + timedelta(days=1)}"
           f"&hourly={','.join(VARS)}&timezone=Asia%2FTaipei")
    return json.load(urllib.request.urlopen(url, timeout=120))["hourly"]


def main():
    ap = argparse.ArgumentParser(description="抓展示用日期的台北實際天氣")
    ap.add_argument("--from", dest="start", help="起日 YYYY-MM-DD（和 --to 成對；可重複用逗號分隔多段）")
    ap.add_argument("--to", dest="end", help="迄日 YYYY-MM-DD")
    args = ap.parse_args()
    if args.start and args.end:
        # 指定期間：展示週換月份時用這個重抓，不必受 history.json 的範圍限制
        lo, hi = date.fromisoformat(args.start), date.fromisoformat(args.end)
        want = [lo + timedelta(days=i) for i in range((hi - lo).days + 1)]
    else:
        hist = json.load(open(os.path.join(DATA, "history.json"), encoding="utf-8"))
        want = [date.fromisoformat(d["date"]) for d in hist["days"]]
    out = {}
    for a, b in spans(want):
        h = fetch(a, b)
        idx = {t: i for i, t in enumerate(h["time"])}
        for d in want:
            if not (a <= d <= b):
                continue
            rows = {k: [] for k in ("temp", "rh", "cloud", "precip", "kt")}
            for hr in range(24):
                t0 = f"{d.isoformat()}T{hr:02d}:00"
                i = idx[t0]
                mean = lambda k: (h[k][i] + h[k][i + 1]) / 2          # noqa: E731
                rows["temp"].append(round(mean("temperature_2m"), 1))
                rows["rh"].append(round(mean("relative_humidity_2m")))
                rows["cloud"].append(round(mean("cloud_cover")))
                rows["precip"].append(round(h["precipitation"][i + 1], 1))
                i0, ghi = h["terrestrial_radiation"][i + 1], h["shortwave_radiation"][i + 1]
                # 晴空指數：地面日射量 ÷ 大氣層頂日射量；太陽太低時比值不穩定，留空
                rows["kt"].append(round(ghi / i0, 3) if i0 >= 30 else None)
            out[d.isoformat()] = rows

    path0 = os.path.join(DATA, "weather.json")
    if args.start and args.end and os.path.exists(path0):
        old = json.load(open(path0, encoding="utf-8")).get("days", {})
        out = {**old, **out}                       # 這次抓到的覆蓋同一天，其餘保留

    payload = {
        "source": "open-meteo ERA5 再分析資料（台北 25.033°N, 121.565°E）",
        "note": "第 h 小時：氣溫／濕度／雲量取 h 與 h+1 整點平均；降雨量、晴空指數取 h+1 那筆（前一小時累積）",
        "days": out,
    }
    path = os.path.join(DATA, "weather.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    print(f"weather.json  {os.path.getsize(path) / 1024:.1f} KB  {len(out)} 天")
    for k, r in out.items():
        print(f"  {k}  {min(r['temp']):.1f}～{max(r['temp']):.1f}°C  雲量平均 {sum(r['cloud']) / 24:.0f}%"
              f"  雨量 {sum(r['precip']):.1f} mm")


if __name__ == "__main__":
    main()

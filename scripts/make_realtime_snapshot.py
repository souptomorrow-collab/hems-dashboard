# -*- coding: utf-8 -*-
"""從整年的秒級資料抽出兩個展示月，每天一檔，給網站的秒級重播用。

為什麼不放資料庫：秒級一年 3,150 萬筆，雲端資料庫（免費方案 512 MB）放不下，
其他組也用不到。所以每天做成一個小檔跟著網站部署，瀏覽器選到哪天才讀哪天。
不存時間戳，時刻由陣列位置推算（第 i 筆 = 00:00:00 + i 秒）。

輸出  public/data/realtime/YYYY-MM-DD.json（每檔約 1 MB，網站傳輸時會壓縮到約 1/3）

執行：python scripts/make_realtime_snapshot.py                 兩個展示月
      python scripts/make_realtime_snapshot.py --month 2010-07
"""
import argparse
import calendar
import csv
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
UI = os.path.dirname(HERE)
OUT = os.path.join(UI, "public", "data", "realtime")
SRC = os.path.join(os.path.dirname(UI), "realtime_year", "data", "csv")
MONTHS = ("2010-07", "2010-01")

NOTE = ("秒級運轉資料：負載每分鐘平均為實測、分鐘內為合成；"
        "太陽能 15 分鐘平均由實測日射量換算、秒級起伏為合成。僅供展示與實時層測試。")


def month(m):
    """讀整月 CSV 一次，按日寫檔"""
    path = os.path.join(SRC, f"realtime_1s_{m}.csv")
    days = calendar.monthrange(int(m[:4]), int(m[5:]))[1]
    load, pv = [], []
    with open(path, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            load.append(round(float(row["non_transferable_load_kw"]), 3))
            pv.append(round(float(row["pv_kw"]), 3))
    if len(load) != days * 86400:
        raise SystemExit(f"{m} 有 {len(load):,} 筆，應該是 {days * 86400:,} 筆")
    os.makedirs(OUT, exist_ok=True)
    total = 0
    for d in range(days):
        day = f"{m}-{d + 1:02d}"
        s = slice(d * 86400, (d + 1) * 86400)
        payload = {"date": day, "interval_s": 1, "n": 86400, "note": NOTE,
                   "units": {"load_kw": "kW", "pv_kw": "kW"},
                   "load_kw": load[s], "pv_kw": pv[s]}
        p = os.path.join(OUT, f"{day}.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        total += os.path.getsize(p)
    print(f"{m}　{days} 天　共 {total / 1e6:.1f} MB（平均每天 {total / days / 1e6:.2f} MB）")


def main():
    ap = argparse.ArgumentParser(description="產生展示月的每日秒級檔")
    ap.add_argument("--month", help="只做這個月；不給就做兩個展示月")
    a = ap.parse_args()
    for m in ([a.month] if a.month else MONTHS):
        month(m)
    print(f"\n輸出在 {os.path.relpath(OUT, UI)}/。push 之後網站上的秒級重播才會更新。")


if __name__ == "__main__":
    main()

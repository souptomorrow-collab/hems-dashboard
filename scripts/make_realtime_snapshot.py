# -*- coding: utf-8 -*-
"""從整年的秒級資料抽出展示日，做成網站用的快照。

為什麼不放資料庫：秒級一年 3,150 萬筆，雲端資料庫（免費方案 512 MB）放不下，
其他組也用不到。所以抽出展示日那一天（86,400 筆）跟著網站一起部署，瀏覽器直接讀。
不存時間戳，時刻由陣列位置推算（第 i 筆 = 00:00:00 + i 秒），檔案才壓得下來。

輸出
  public/data/realtime_day.json              夏月展示日
  public/data/realtime_day_non_summer.json   非夏月展示日

執行：python scripts/make_realtime_snapshot.py
      python scripts/make_realtime_snapshot.py --summer 2010-07-19 --non-summer 2010-01-11
"""
import argparse
import csv
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
UI = os.path.dirname(HERE)
DATA = os.path.join(UI, "public", "data")
SRC = os.path.join(os.path.dirname(UI), "realtime_year", "data", "csv")

NOTE = ("秒級運轉資料：負載每分鐘平均為實測、分鐘內為合成；"
        "太陽能 15 分鐘平均由實測日射量換算、秒級起伏為合成。僅供展示與實時層測試。")


def one_day(day):
    """從該月的 CSV 逐行讀出這一天的 86,400 筆（整檔 75 MB，不整包載入記憶體）"""
    path = os.path.join(SRC, f"realtime_1s_{day[:7]}.csv")
    if not os.path.exists(path):
        raise SystemExit(f"找不到 {path}")
    load, pv = [], []
    with open(path, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            if not row["time"].startswith(day):
                if load:                      # 已經抓完這一天，後面不用再看
                    break
                continue
            load.append(round(float(row["non_transferable_load_kw"]), 4))
            pv.append(round(float(row["pv_kw"]), 4))
    if len(load) != 86400:
        raise SystemExit(f"{day} 只有 {len(load):,} 筆，應該是 86,400 筆")
    return load, pv


def write(day, name):
    load, pv = one_day(day)
    payload = {
        "date": day, "interval_s": 1, "n": len(load), "note": NOTE,
        "units": {"load_kw": "kW", "pv_kw": "kW"},
        "load_kw": load, "pv_kw": pv,
    }
    path = os.path.join(DATA, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    mb = os.path.getsize(path) / 1e6
    print(f"{name:32} {day}　{len(load):,} 筆　{mb:.2f} MB　"
          f"負載 {min(load):.2f}~{max(load):.2f} kW　太陽能 {min(pv):.2f}~{max(pv):.2f} kW")


def main():
    ap = argparse.ArgumentParser(description="產生展示日的秒級快照")
    ap.add_argument("--summer", default="2010-07-19")
    ap.add_argument("--non-summer", dest="non_summer", default="2010-01-11")
    a = ap.parse_args()
    write(a.summer, "realtime_day.json")
    write(a.non_summer, "realtime_day_non_summer.json")
    print("\n完成。push 之後網站上的秒級重播才會換成這兩天。")


if __name__ == "__main__":
    main()

# -*- coding: utf-8 -*-
"""
把排程組的排程結果（MongoDB hems.schedule，tag=main）匯出成 public/data/schedule.json。

為什麼要這支：
    UI 原本的電池調度是 src/lib/simulate.js 自己模擬的。排程組已經有 MILP 的實際結果，
    UI 應該照那份排程顯示電池充放電與 SOC。瀏覽器連不到 MongoDB（見 src/api/forecastData.js），
    所以和預測一樣匯出成靜態快照一起部署。

只匯出從 00:00 開始的排程，每份只取「採用」的前 use_steps 格（24 小時 = 96 格）。
負載預測組共用 repo 的 04_export_web.py 不動，排程的匯出放在 UI 這邊。

執行（需要連線字串，環境變數 MONGO_URI）：python scripts/export_schedule.py
"""
import os
import json
import sys
from datetime import datetime, timezone, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(HERE), "public", "data")
TW = timezone(timedelta(hours=8))
FIELDS = ["price", "load_kw", "pv_kw", "pv_used_kw", "grid_buy_kw", "batt_kw", "soc_pct"]


def fmt(t):
    return t.strftime("%Y-%m-%d %H:%M") if t else None


def main():
    uri = os.environ.get("MONGO_URI")
    if not uri:
        sys.exit("找不到環境變數 MONGO_URI")
    from pymongo import MongoClient
    col = MongoClient(uri, serverSelectionTimeoutMS=15000)["hems"]["schedule"]

    out = []
    for doc in col.find({"tag": "main"}).sort("start_time", 1):
        st = doc["start_time"]
        if st.hour or st.minute:
            continue                          # UI 以「一天」為單位，只收從 00:00 開始的排程
        use = doc.get("use_steps", doc["n_steps"])
        steps = sorted(doc["steps"], key=lambda s: s["k"])[:use]
        if len(steps) != 96:
            print(f"略過 {fmt(st)}：採用 {len(steps)} 格，不是一整天")
            continue
        if any("price" not in s for s in steps):
            print(f"略過 {fmt(st)}：沒有電價，UI 無法確認和當天電價一致")
            continue
        item = {
            "date": st.strftime("%Y-%m-%d"),
            "start_time": fmt(st),
            "solver": (doc.get("summary") or {}).get("solver"),
            "smooth_weight": (doc.get("summary") or {}).get("smooth_weight"),
            "omega": doc.get("omega"),
            "load_refresh_time": fmt(doc.get("load_refresh_time")),
            "pv_refresh_time": fmt(doc.get("pv_refresh_time")),
            "totals": doc.get("totals"),
            "note": doc.get("note"),
            "uploaded_at": fmt(doc.get("uploaded_at")),
        }
        for k in FIELDS:
            item[k] = [round(float(s[k]), 4) for s in steps]
        out.append(item)

    payload = {
        "generated_at": datetime.now(TW).strftime("%Y-%m-%d %H:%M:%S"),
        "source": "MongoDB Atlas · hems.schedule（tag=main）",
        "note": "batt_kw 正＝充電；soc_pct 為該格結束時的電量；每份只含採用的 24 小時",
        "schedules": out,
    }
    path = os.path.join(DATA, "schedule.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    print(f"schedule.json  {os.path.getsize(path) / 1024:.1f} KB  {len(out)} 份")
    for s in out:
        t = s["totals"] or {}
        print(f"  {s['date']}  {s['solver']}  電費 {t.get('cost', 0):.2f} 元  買電 {t.get('grid_kwh', 0):.2f} kWh"
              f"  SOC {min(s['soc_pct']):.1f}～{max(s['soc_pct']):.1f}%")


if __name__ == "__main__":
    main()

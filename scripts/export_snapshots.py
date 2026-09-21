# -*- coding: utf-8 -*-
"""
從後端 API（hems-api）匯出 UI 的靜態快照到 public/data/。不需要資料庫連線字串。

  forecast_day.json               夏月展示日 2010-07-19（/forecast/day?season=summer）
  forecast_day_non_summer.json    非夏月展示日 2010-01-11（/forecast/day?season=non_summer）
  history.json                    歷史紀錄（/history，一整年）
  schedule.json                   排程組的排程（/schedules，tag=main）

快照是 API 連不上時的備援，內容和 API 回傳相同。資料庫更新後重跑這支再 push，備援才會跟著更新。
資料庫格式改成 hems_db 第 2 版（2026-09-17）後，負載預測共用 repo 的 04_export_web.py 讀不懂新格式，
所以改由這支透過 API 匯出；天氣照舊用 scripts/fetch_weather.py。

執行：python scripts/export_snapshots.py [API 網址]（預設 https://hems-api.vercel.app）
      python scripts/export_snapshots.py local   直接在本機跑 API（不開伺服器、不等部署、不受 CDN 快取影響）
"""
import json
import os
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(HERE), "public", "data")
BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://hems-api.vercel.app").rstrip("/")

FILES = [
    ("forecast_day.json", "/forecast/day?season=summer", 1),
    ("forecast_day_non_summer.json", "/forecast/day?season=non_summer", 1),
    ("history.json", "/history", 1),
    ("schedule.json", "/schedules", None),
    ("operation.json", "/operation", None),
]


if BASE == "local":
    # 本機模式：把 hems-api 的 FastAPI app 直接掛進 TestClient，不開伺服器、不經過網路。
    # 資料庫剛改完、Vercel 還沒部署或 CDN 還在快取舊內容時用這個。
    API_DIR = os.path.join(os.path.dirname(os.path.dirname(HERE)), "hems-api")
    sys.path.insert(0, os.path.join(API_DIR, "api"))
    sys.path.insert(0, os.path.join(API_DIR, "shared"))
    from fastapi.testclient import TestClient      # noqa: E402
    import index                                   # noqa: E402
    _client = TestClient(index.app)

    def get(path):
        r = _client.get(path)
        r.raise_for_status()
        return r.json()
else:
    def get(path):
        # 加上時間戳避開 CDN 快取，確保拿到資料庫的最新內容
        url = f"{BASE}{path}{'&' if '?' in path else '?'}fresh={int(time.time())}"
        with urllib.request.urlopen(url, timeout=120) as r:
            return json.load(r)


def check(name, d):
    if name.startswith("forecast_day"):
        assert len(d["slots"]) == 96 and len(d["rolling"]) == 96, name
        assert d["pv"] and len(d["pv"]) == 96, f"{name} 沒有發電量預測"
    elif name == "history.json":
        assert d["days"] and all(len(x["day_ahead"]) == 96 for x in d["days"]), name
    elif name == "operation.json":
        assert d["days"] and all(len(x["soc_pct"]) == 96 for x in d["days"]), "實時運轉紀錄不完整"
    else:
        assert d["schedules"], "沒有排程"


for name, path, indent in FILES:
    d = get(path)
    check(name, d)
    with open(os.path.join(DATA, name), "w", encoding="utf-8") as f:
        if indent:
            json.dump(d, f, ensure_ascii=False, indent=indent)
        else:
            json.dump(d, f, ensure_ascii=False, separators=(",", ":"))
    extra = ""
    if name == "history.json":
        extra = f"　{len(d['days'])} 天（{d['days'][0]['date']} ~ {d['days'][-1]['date']}）"
    elif name.startswith("forecast_day"):
        extra = f"　展示日 {d['target_date']}"
    elif name == "operation.json":
        extra = f"　{len(d['days'])} 天"
    else:
        extra = f"　{len(d['schedules'])} 份"
    print(f"{name:30s} {os.path.getsize(os.path.join(DATA, name)) / 1024:7.0f} KB{extra}")
print("完成。push 之後網站的備援快照才會更新。")

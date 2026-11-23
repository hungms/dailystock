"""讀取 stocks.json，以 yfinance 下載每日價格，輸出 data/prices.json。"""

import json
import math
from datetime import datetime, timezone
from pathlib import Path

import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
STOCKS_FILE = ROOT / "stocks.json"
OUT_FILE = ROOT / "data" / "prices.json"
KEEP_DAYS = 90


def num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) else round(f, 4)


def fetch_one(symbol, fallback_name):
    t = yf.Ticker(symbol)
    hist = t.history(period="6mo", interval="1d", auto_adjust=False)
    rows = []
    for idx, r in hist.tail(KEEP_DAYS).iterrows():
        h, l, c = num(r["High"]), num(r["Low"]), num(r["Close"])
        if h is None or l is None or c is None:
            continue
        rows.append({"d": idx.strftime("%Y-%m-%d"), "o": num(r["Open"]), "h": h, "l": l, "c": c})

    current = rows[-1]["c"] if rows else None
    try:
        lp = num(t.fast_info.get("lastPrice"))
        if lp is not None:
            current = lp
    except Exception:
        pass

    name = fallback_name
    if not name:
        try:
            info = t.info
            name = info.get("shortName") or info.get("longName") or symbol
        except Exception:
            name = symbol

    return {"name": name, "current": current, "history": rows}


def main():
    stocks = json.loads(STOCKS_FILE.read_text(encoding="utf-8")).get("stocks", [])
    old = {}
    if OUT_FILE.exists():
        try:
            old = json.loads(OUT_FILE.read_text(encoding="utf-8")).get("stocks", {})
        except Exception:
            old = {}

    out = {}
    for s in stocks:
        sym = s["symbol"]
        try:
            data = fetch_one(sym, s.get("name"))
            if not data["history"] and sym in old:
                data = old[sym]  # 下載失敗時保留舊資料
            out[sym] = data
            print(f"{sym}: {len(data['history'])} 日")
        except Exception as e:
            print(f"{sym}: 失敗 {e}")
            if sym in old:
                out[sym] = old[sym]

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(
        json.dumps(
            {"updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "stocks": out},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()

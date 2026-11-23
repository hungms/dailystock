"""讀取 stocks.json，以 yfinance 一次過下載所有股票的每日價格，輸出 data/prices.json。

上一次的資料會從已發佈的網站（環境變數 PAGES_URL）讀取，
用於：下載失敗時保留舊資料，以及重用股票名稱（避免每次逐隻查詢）。
"""

import json
import math
import os
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
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


def load_previous():
    url = os.environ.get("PAGES_URL", "").strip()
    if url:
        try:
            full = url.rstrip("/") + "/data/prices.json"
            with urllib.request.urlopen(full, timeout=30) as r:
                print(f"讀取上次資料：{full}")
                return json.loads(r.read().decode("utf-8")).get("stocks", {})
        except Exception as e:
            print(f"無法讀取上次資料（{e}）")
    if OUT_FILE.exists():
        try:
            return json.loads(OUT_FILE.read_text(encoding="utf-8")).get("stocks", {})
        except Exception:
            pass
    return {}


def frame_for(df, sym):
    if isinstance(df.columns, pd.MultiIndex):
        if sym not in df.columns.get_level_values(0):
            return None
        return df[sym]
    return df


def rows_from(frame):
    rows = []
    if frame is None:
        return rows
    for idx, r in frame.tail(KEEP_DAYS).iterrows():
        h, l, c = num(r.get("High")), num(r.get("Low")), num(r.get("Close"))
        if h is None or l is None or c is None:
            continue
        rows.append({"d": idx.strftime("%Y-%m-%d"), "h": h, "l": l, "c": c})
    return rows


def lookup_name(sym):
    try:
        info = yf.Ticker(sym).info
        return info.get("shortName") or info.get("longName") or sym
    except Exception:
        return sym


def main():
    stocks = json.loads(STOCKS_FILE.read_text(encoding="utf-8")).get("stocks", [])
    symbols = [s["symbol"] for s in stocks]
    old = load_previous()

    df = None
    if symbols:
        df = yf.download(
            symbols, period="6mo", interval="1d", group_by="ticker",
            threads=True, auto_adjust=False, progress=False,
        )

    out, failed = {}, []
    for s in stocks:
        sym = s["symbol"]
        rows = rows_from(frame_for(df, sym)) if df is not None else []
        prev = old.get(sym) or {}
        if not rows:
            failed.append(sym)
            if prev.get("history"):
                out[sym] = prev
            continue
        name = s.get("name") or prev.get("name") or lookup_name(sym)
        out[sym] = {"name": name, "current": rows[-1]["c"], "history": rows}

    print(f"完成 {len(out)}/{len(stocks)} 隻")
    if failed:
        print("下載失敗：" + ", ".join(failed))

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

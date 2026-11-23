"""讀取 stocks.json，以 yfinance 一次過下載所有股票的每日價格，輸出 data/prices.json；
並從港交所證券名單產生繁體中文股票名稱 data/names.json。

上一次的資料會從已發佈的網站（環境變數 PAGES_URL）讀取，
用於：下載失敗時保留舊資料及名稱。
"""

import json
import math
import os
import io
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
STOCKS_FILE = ROOT / "stocks.json"
OUT_FILE = ROOT / "data" / "prices.json"
NAMES_FILE = ROOT / "data" / "names.json"
HKEX_URL = "https://www.hkex.com.hk/chi/services/trading/securities/securitieslists/ListOfSecurities_c.xlsx"
KEEP_DAYS = 90


def num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) else round(f, 4)


def load_previous(rel, local):
    """先從已發佈網站讀取上次的檔案，失敗則讀本機檔案。"""
    url = os.environ.get("PAGES_URL", "").strip()
    if url:
        try:
            full = url.rstrip("/") + "/" + rel
            with urllib.request.urlopen(full, timeout=30) as r:
                print(f"讀取上次資料：{full}")
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            print(f"無法讀取 {rel}（{e}）")
    if local.exists():
        try:
            return json.loads(local.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def load_hkex_names():
    """下載港交所證券名單（繁體中文），只保留 5 位數以下的代號（股票、基金、REIT），略過窩輪及牛熊證。"""
    import openpyxl

    req = urllib.request.Request(HKEX_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    ws = openpyxl.load_workbook(io.BytesIO(data)).active  # 不可用 read_only，否則讀不到全部行
    names = {}
    for row in ws.iter_rows(values_only=True):
        code = str(row[0] or "").strip()
        if code.isdigit() and int(code) < 10000 and row[1]:
            names[code.zfill(5)] = str(row[1]).strip()
    print(f"港交所名稱：{len(names)} 個")
    return names


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
    old = load_previous("data/prices.json", OUT_FILE).get("stocks", {})

    try:
        names = load_hkex_names()
    except Exception as e:
        print(f"無法下載港交所名單（{e}），沿用上次名稱")
        names = load_previous("data/names.json", NAMES_FILE)
    NAMES_FILE.parent.mkdir(parents=True, exist_ok=True)
    NAMES_FILE.write_text(json.dumps(names, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

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
        hkex = names.get(sym.replace(".HK", "").zfill(5))
        name = s.get("name") or hkex or prev.get("name") or lookup_name(sym)
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

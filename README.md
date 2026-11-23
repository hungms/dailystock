# 港股每日紀錄

追蹤關注港股的每日最高、最低、波幅及現價（最近 14 個交易日），點擊股票名稱可查看帶高低區間的走勢圖。

- 純靜態網站，以 GitHub Pages 發佈
- GitHub Actions 每個交易日於港股交易時段內每小時以 `yfinance` 下載股價，並直接發佈到 GitHub Pages（股價資料不存入 git，儲存庫不會越來越大）
- 關注列表存於儲存庫內的 `stocks.json`
- 為 iPad 橫向使用設計：大字體，表格可左右及上下捲動，日期欄及表頭固定；可用搜尋框跳至指定股票
- 顏色：與前一交易日同一數值比較，紅色為上升，藍色為下跌

## 首次設定

1. **推送到 GitHub**
   ```bash
   git remote add origin https://github.com/<你的帳號>/dailystock.git
   git push -u origin main
   ```
2. **開啟 GitHub Pages**：儲存庫 → Settings → Pages → Source 選 **「GitHub Actions」**。
3. 到 Actions 分頁，選「更新股價並發佈」→「Run workflow」執行第一次發佈（之後每次推送及交易時段每小時會自動執行）。

網址：`https://<你的帳號>.github.io/dailystock/`

## 在網頁上新增／移除股票

網頁會透過 GitHub API 直接修改 `stocks.json`，並觸發更新。需要一個權杖：

1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token
2. Repository access：只選此儲存庫
3. Permissions：**Contents** 設為 Read and write
4. 在網頁按「設定」，貼上權杖（儲存庫名稱在 GitHub Pages 上會自動偵測）

「＋ 新增」可一次輸入多隻股票，以逗號、空格或換行分隔，每行可在代號後加上中文名稱，例如：

```
700, 9988, 5
1810 小米集團
0388.HK 香港交易所
```

未填名稱的股票會自動使用 Yahoo Finance 的英文簡稱。新增後約 2 分鐘資料便會出現。

權杖只儲存在你的瀏覽器（localStorage），不會寫入儲存庫。沒有權杖的訪客只能瀏覽。

亦可直接編輯 `stocks.json`：

```json
{ "stocks": [ { "symbol": "0700.HK", "name": "騰訊控股" } ] }
```

## 本機預覽

```bash
pip install -r requirements.txt
python scripts/fetch_prices.py   # 產生 data/prices.json
python -m http.server            # 開啟 http://localhost:8000
```

## 說明

- 「現價」欄：今日為最新價，過往日子為收市價；下方為與前一日收市比較的升跌百分比。
- 顏色：最高、最低、波幅、現價各自與前一交易日的同一數值比較，紅色為上升，藍色為下跌，黑色為不變。
- 波幅 ＝ 最高 − 最低，下方為佔最低價的百分比。
- 資料來源為 Yahoo Finance，可能有約 15 分鐘延遲。

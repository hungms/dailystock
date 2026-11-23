# 港股每日紀錄

追蹤關注港股的每日最高、最低、波幅及現價（最近 14 個交易日），點擊股票名稱可查看帶高低區間的走勢圖。

- 純靜態網站，以 GitHub Pages 發佈
- GitHub Actions 每個交易日於港股交易時段內每小時以 `yfinance` 更新 `data/prices.json`
- 關注列表存於儲存庫內的 `stocks.json`

## 首次設定

1. **推送到 GitHub**
   ```bash
   git remote add origin https://github.com/<你的帳號>/dailystock.git
   git push -u origin main
   ```
2. **開啟 GitHub Pages**：儲存庫 → Settings → Pages → Source 選「Deploy from a branch」，Branch 選 `main`、資料夾 `/ (root)`。
3. **允許 Actions 寫入**：Settings → Actions → General → Workflow permissions 選「Read and write permissions」。
4. （可選）到 Actions 分頁，選「更新股價」→「Run workflow」手動更新一次。

網址：`https://<你的帳號>.github.io/dailystock/`

## 在網頁上新增／移除股票

網頁會透過 GitHub API 直接修改 `stocks.json`，並觸發更新。需要一個權杖：

1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token
2. Repository access：只選此儲存庫
3. Permissions：**Contents** 設為 Read and write，**Actions** 設為 Read and write
4. 在網頁按「設定」，貼上權杖（儲存庫名稱在 GitHub Pages 上會自動偵測）

權杖只儲存在你的瀏覽器（localStorage），不會寫入儲存庫。沒有權杖的訪客只能瀏覽。

亦可直接編輯 `stocks.json`：

```json
{ "stocks": [ { "symbol": "0700.HK", "name": "騰訊控股" } ] }
```

## 本機預覽

```bash
pip install -r requirements.txt
python scripts/fetch_prices.py   # 更新資料
python -m http.server            # 開啟 http://localhost:8000
```

## 說明

- 「現價」欄：今日為最新價，過往日子為收市價；顏色以前一日收市比較（綠升紅跌）。
- 波幅 ＝ 最高 − 最低，括號內為佔最低價百分比。
- 資料來源為 Yahoo Finance，可能有約 15 分鐘延遲。

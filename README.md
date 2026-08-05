# 機捷快轉 🚇

桃園機場捷運**快速轉乘計算器**。直達車過站不停、比普通車快很多，所以像「台北車站→橫山」搭直達車到機場第二航廈再轉普通車，會比普通車一路坐到底更快；「台北車站→坑口」則可以搭直達車到機場第一航廈再往北折返（同月台、不用換層）。本工具依**當下或指定的出發時間**逐班比較，找出最快搭法。

**網站**：https://chung223.github.io/tymetrofast/

## 功能

- 🚄 逐班車時刻計算：比較「直達車＋轉乘」與「普通車直達」，含轉乘等候時間
- 🔀 自動找出「搭過站再折返」的路線（如經 A12 回頭到坑口）
- 🕐 依現在時間（台灣時區）或指定日期時間查詢，自動判別平日／假日／國定假日班表
- 📱 行動裝置優先的 RWD、捷運月台看板風格介面
- 🔁 時刻表資料化：桃捷改點時改資料檔即可，push 後自動重新部署

## 桃捷改點了怎麼更新？

三種方式，由簡到細：

### 方式一：跑 TDX 自動更新（建議）

到 repo 的 **Actions → 更新官方時刻表（TDX） → Run workflow**。工作流程會從 [TDX 運輸資料流通服務](https://tdx.transportdata.tw) 抓桃捷官方各站時刻表，串連成逐班車時刻、驗證後自動 commit，接著自動重新部署。每週六清晨也會自動執行一次。

> **建議設定 TDX 金鑰**（匿名存取很容易被限流）：到 [TDX](https://tdx.transportdata.tw) 免費註冊會員 → 會員專區取得 Client Id / Secret，然後在 repo **Settings → Secrets and variables → Actions** 新增 `TDX_CLIENT_ID` 與 `TDX_CLIENT_SECRET`。

### 方式二：在 GitHub 網頁上編輯班距模式

直接編輯 [`data/patterns.json`](data/patterns.json)（發車帶、班距、行駛時間、待避規則），commit 到 `main` 後部署流程會自動展開成逐班時刻並上線。適合官方只公告「班距調整」時快速跟上。

> 注意：若 `data/timetable.json` 目前是 TDX 官方資料（`dataStatus: "official"`），部署時**不會**用 patterns 覆蓋它；要改用 patterns 請先在本機跑 `node scripts/build-timetable.mjs` 並 commit。

### 方式三：直接編輯逐班時刻

編輯 [`data/timetable.json`](data/timetable.json)（格式見下方），適合微調個別班次。

其他資料檔：

- [`data/network.json`](data/network.json)：車站、直達車停靠站、**同站轉乘秒數**（影響轉乘銜接判定）
- [`data/holidays.json`](data/holidays.json)：套用假日班表的國定假日清單（每年更新一次）

## 一次性設定：啟用 GitHub Pages

merge 進 `main` 後，到 **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**（部署流程也會嘗試自動啟用）。之後每次 push 到 `main` 都會自動部署。

## 資料格式

`data/timetable.json`（網站唯一消費的班表檔）：

```jsonc
{
  "version": "tdx-2026-08-05",
  "dataStatus": "official",       // official=TDX 官方、estimate=班距推估
  "dayTypes": {
    "weekday": [                   // 平日；holiday=週末與國定假日
      {
        "id": "S-EXP-0600",
        "type": "express",         // express=直達車、local=普通車
        "dir": "S",                // S=往老街溪、N=往台北
        "stops": [["A1", 360], ["A3", 367.5]]   // [站碼, 當日第幾分鐘]
      }
    ]
  }
}
```

時間以「當日 00:00 起算的分鐘數」表示，跨午夜班次可超過 1440（清晨 3 點前視為前一營運日）。

## 開發

純靜態網站、零建置框架：

```bash
node scripts/build-timetable.mjs   # patterns.json → timetable.json
node scripts/test-planner.mjs      # 轉乘引擎情境測試
python3 -m http.server 8000        # 本地預覽 http://localhost:8000
```

轉乘引擎（`assets/planner.js`）以逐班車時刻做 Connection Scan 最早抵達演算法，把每班車拆成站間連結後依發車時刻掃描，天然涵蓋轉乘與折返路線；`scripts/tdx-to-timetable.mjs` 把 TDX「各站時刻表」用順序保持的最小成本對齊串回逐班車。

## 免責聲明

非官方工具。時刻與轉乘建議僅供參考，實際請以[桃園捷運官方時刻表](https://www.tymetro.com.tw/tymetro-new/tw/_pages/travel-guide/timetable.html)與現場資訊為準。

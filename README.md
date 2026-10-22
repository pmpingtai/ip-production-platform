# 風雅存製作團隊 LINE 官方帳號

團隊成員透過 LINE 官方帳號查看自己的工作與進度，不需要直接操作 Notion，也就不會誤刪 Notion 的欄位或資料。架構沿用苗栗收容所系統與 line-namecard 會員模組：**LINE 官方帳號＋LIFF（GitHub Pages）＋Make.com＋Notion**。

## 使用流程

```
加好友 ──► 訪客選單［加入團隊成員］──填姓名與角色──► 審核中
                                              │
          製作人或導演在［核准團隊成員］確認角色 ◄──┘（LINE 推播通知）
                                              │
     ┌────────────────────────────────────────┴──────────────────┐
編劇、藝術總監、作畫監督、聲音總監                             製作人、導演
團隊成員選單［我的工作］［我的進度］                  製作人／導演選單［核准團隊成員］［團隊進度］
```

| 畫面 | 網址參數 | 誰能用 | 內容 |
|---|---|---|---|
| 加入團隊成員 | `?v=join` | 所有人 | 填真實姓名、選角色、補充說明；審核中可修改 |
| 我的工作 | `?v=work` | 團隊成員 | 退回修改、已逾期、本週到期、之後的工作 |
| 我的進度 | `?v=progress` | 團隊成員 | 完成率、各階段進度、依狀態分組的任務 |
| 核准團隊成員 | `?v=approve` | 製作人、導演 | 待核准名單，確認角色後核准或退回 |
| 團隊進度 | `?v=team` | 製作人、導演 | 版面同「我的進度」，可切換全部或單一角色 |

導演與製作人目前用同一套畫面，但 LINE 上是兩張選單（別名 `producer`、`director`），之後要分開調整時改 `tools/make_richmenu.py` 與 `tools/make_blueprints.py` 的 `MENUS` 即可。

## 組成

| 部分 | 位置 | 說明 |
|---|---|---|
| LIFF 頁面 | `liff/app/` | `index.html` 版面、`app.js` 程式、`stats.js` 統計、`roles.json` 角色設定；`mock.js`、`mock-data.js` 只在本機預覽時載入 |
| 角色設定 | `liff/app/roles.json` | 六個角色、可核准的角色，以及 Notion「執行職掌」舊職稱的對應。頁面與藍圖產生器共用 |
| Make 情境 | `tools/make_blueprints.py` 產生到 `make/` | 「風雅存｜LIFF API」「風雅存｜LINE 事件」「風雅存｜建立圖文選單（手動執行）」 |
| 選單圖片 | `tools/make_richmenu.py` 產生到 `assets/` | 四張 2500 × 843 單列選單 |
| Notion | 「📱 LINE 官方帳號｜團隊成員與選單」頁 | 「👥 LINE 團隊成員」名冊；任務讀「📋 製作流程查核總表」、專案讀「📁 風雅存_專案資料庫」 |

## 權限與資料範圍

- 每次請求都先向 LINE 驗證 Access Token 屬於本系統的 LINE Login channel，再用 userId 查名冊。
- 總監只會拿到自己角色的任務；導演與製作人拿到全部任務。這個篩選在 Make 端做，不靠頁面。
- 核准、退回、待核准名單只開放給 `roles.json` 的 `approvers`（製作人、導演），也是在 Make 端檢查。
- 任務資料**只讀不寫**：Make 對「📋 製作流程查核總表」只有查詢，沒有任何更新或刪除模組。唯一會寫入的是「👥 LINE 團隊成員」名冊。

## 本機預覽

```bash
python -m http.server 5192 --directory liff/app
```

打開 `http://localhost:5192/?as=製作人`。`as` 可以換成 `guest`、`pending`、`rejected` 或六個角色之一，`v` 指定畫面。本機用的是 `mock-data.js` 的 Notion 快照，狀態與日期是虛構的。

## 測試

```bash
node --test test/stats.test.mjs
```

## 部署與交接

- [docs/部署說明.md](docs/部署說明.md)：從零在自己的帳號架起整套系統
- [docs/交接清單.md](docs/交接清單.md)：整套移交給風雅存時要轉移的帳號與設定

## Make 的地雷（沿用苗栗與 line-namecard 的經驗）

- 用 API 建立的 HTTP 模組要補上預設值（`HTTP_DEFAULTS`），否則請求不會送出。
- HTTP 模組遇到 4xx 會中斷整個執行；錯誤處理路線要放 Webhook response＋Ignore，頁面才收得到錯誤。
- Router 一定是路線的最後一個模組，後面接的模組不會執行。
- 匯入 webhook 觸發的情境後，確認排程仍是「Immediately」；曾發生匯入後變成每 15 分鐘，頁面只收到「Accepted」。
- 「Create a Rich Menu」勾了 selected 會把剛建好的那張設成預設，所以「設為預設選單」放在四張都建完之後。
- 只偶爾手動執行的情境（建立圖文選單）排程設成「On demand」並保持開啟。
- Notion 欄位一改名，Make 就讀不到。名冊建好後請鎖定資料庫。

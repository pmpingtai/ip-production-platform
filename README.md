# ip-production-platform

製作團隊用的 LINE 工作頁面（LIFF），搭配自動化流程與資料庫使用。

## 目錄

| 位置 | 內容 |
|---|---|
| `liff/app/` | 頁面程式 |
| `assets/` | 選單圖片 |
| `tools/` | 產生設定與選單圖片的工具 |
| `make/example/` | 範例設定（不含實際 ID） |
| `test/` | 單元測試 |

## 本機預覽

```bash
python -m http.server 5192 --directory liff/app
```

本機預覽使用虛構的示範資料。

## 測試

```bash
node --test test/stats.test.mjs
```

## 文件

部署、設定與維運說明另行提供，不放在這個版本庫。

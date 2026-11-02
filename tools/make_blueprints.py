"""產生風雅存 LINE 官方帳號的四個 Make 情境藍圖，輸出到 make/（範例設定輸出到 make/example/）：

- LIFF_API.blueprint.json：「風雅存｜LIFF API」
    LIFF 頁面用表單格式送到同一個 webhook，欄位 a 是動作、t 是 LIFF Access Token：
    me 我的身分（順便校正選單）｜apply 申請加入｜tasks 任務與專案｜links 專案雲端資料夾｜pending 待核准名單｜approve 核准｜reject 退回
    task 任務明細｜save 交件｜review 審核｜push_get／push_set／push_now 專案進度推播的設定與試推
    setup 建立專案工作（平台管理者：從範本任務複製新專案的任務、IP 分類、推播設定）
- LINE事件.blueprint.json：「風雅存｜LINE 事件」加好友就在名冊建一筆訪客；封鎖時標記
- 建立圖文選單.blueprint.json：「風雅存｜建立圖文選單（手動執行）」建四張選單、訪客選單設為預設、
    其他三張設別名（member、producer、director），清掉舊選單後把已核准的成員重新綁定
- 進度推播.blueprint.json：「風雅存｜進度推播（每小時）」找出這個整點要每日推播的專案，逐一推給專案成員

身分與選單（2026-11-02 起角色依專案設定，記在帳號管理的「🧩 專案角色」，一人可以在多個專案兼多個角色）：
    沒有已核准的角色、或名冊被停用 → 訪客選單（預設，不綁個人）
    取最高的角色：製片人 → 製片人選單（producer）；導演或副製片 → 導演選單（director）；
    編劇、藝術總監、動畫總監、聲音總監 → 團隊成員選單（member）
權限：製片人的申請由平台管理者核准；其他角色由該專案的製片人或平台管理者核准。
    平台管理者（名冊勾選）用製片人選單，看得到所有專案。
    總監的工作由該專案的導演審核；導演、副製片、製片人的工作由該專案的製片人審核。

執行：python tools/make_blueprints.py            （讀 tools/config.local.json）
      python tools/make_blueprints.py --example  （讀 tools/config.example.json，輸出到 make/example/）
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXAMPLE = "--example" in sys.argv
CFG = json.loads((ROOT / "tools" / ("config.example.json" if EXAMPLE else "config.local.json")).read_text(encoding="utf-8"))
ROLES_CFG = json.loads((ROOT / "liff" / "app" / "roles.json").read_text(encoding="utf-8"))

MK, LN, NT = CFG["make"], CFG["line"], CFG["notion"]
CONN_NOTION, CONN_LINE, CONN_DRIVE = MK["notion_connection_id"], MK["line_connection_id"], MK["drive_connection_id"]
DRIVE_FOLDER = MK["drive_folder_id"]
CHANNEL = LN["login_channel_id"]
LIFF = f"https://liff.line.me/{LN['liff_id']}"
DS_MEMBER, DS_TASK, DS_PROJECT, DS_REVIEW = NT["members_ds"], NT["tasks_ds"], NT["projects_ds"], NT["reviews_ds"]
DB_REVIEW = NT["reviews_db"]   # 查審核紀錄用 Notion API（查不到資料時也會回傳空陣列）
DS_ASSIGN, DB_ASSIGN = NT["assign_ds"], NT["assign_db"]   # 🧩 專案角色：誰、哪個專案、什麼角色
DS_IP = NT["ip_ds"]   # 專案 IP 資料庫：每個專案七個分類的雲端資料夾（雲端連結、專案、排序）
DB_TASK, DB_PUSH = NT["tasks_db"], NT["push_db"]   # 進度推播：任務計數、📣 專案推播（每個專案一筆設定）
DB_TEMPLATE, DB_IP = NT["template_db"], NT["ip_db"]   # 建立專案工作：📐 動畫專案範本任務、專案 IP 資料庫
IP_FOLDERS = ["企劃書資料庫", "劇本資料庫", "美術資料庫", "動畫資料庫", "聲音資料庫", "最終交付檔案", "法律相關文件"]
PAGES = CFG["pages_base"].rstrip("/")
ORIGIN = CFG.get("page_origin") or "*"
PREFIX = f"{CFG['project']}｜" if CFG.get("project") else ""

CREATORS, MANAGERS, APPROVERS = ROLES_CFG["creators"], ROLES_CFG["managers"], ROLES_CFG["approvers"]
ROLES = CREATORS + MANAGERS
ALIASES = ROLES_CFG["aliases"]
APPLY_ROLES = ROLES   # 七個角色都開放申請（2026-11-02 起）；製片人的申請只有平台管理者能核准

# 選單（Notion「目前選單」的選項）→ LINE 選單別名、圖片檔名、按鈕（相對 LIFF 網址的參數、說明）
MENUS = {
    "訪客": (None, "richmenu_guest.png", [("?v=join", "加入團隊成員")]),
    # 我的進度已併入我的工作（2026-11-02），團隊成員選單兩格
    "團隊成員": ("member", "richmenu_member.png", [("?v=work", "我的工作"), ("?v=cloud", "雲端資料夾")]),
    "導演": ("director", "richmenu_director.png", [("?v=team", "團隊進度"), ("?v=work", "我的工作"), ("?v=cloud", "雲端資料夾")]),
    "製片人": ("producer", "richmenu_producer.png", [("?v=approve", "核准團隊成員"), ("?v=team", "團隊進度"), ("?v=work", "我的工作"),
                                                   ("?v=cloud", "雲端資料夾")]),
}
MENU_W, MENU_H = 2500, 843   # 單列選單；和 tools/make_richmenu.py 一致

# HTTP「Make a request」模組的必填設定。用 API 建立時不會自動帶入，少了會報 BundleValidationError
HTTP_DEFAULTS = {"rejectUnauthorized": True, "followRedirect": True, "followAllRedirects": False, "useQuerystring": False,
                 "gzip": True, "useMtls": False}
LINE_META = [{"name": "__IMTCONN__", "type": "account:line2", "label": "Connection", "required": True}]
NOTION_META = [{"name": "__IMTCONN__", "type": "account:notion2,notion3", "label": "Connection", "required": True}]


# ---- 運算式小工具 ----
def c(a, o, b=None):
    d = {"a": a, "o": o}
    if b is not None:
        d["b"] = b
    return d


def flt(name, groups):
    return {"name": name, "conditions": groups}


def sp(mod, prop, suffix=""):
    return "{{" + f"{mod}.properties_value.`{prop}`{suffix}" + "}}"


def inner(expr):
    """{{x}} → x，用來把運算式放進另一個運算式裡"""
    return expr[2:-2]


def enc(expr):
    """自由文字放進手組的 JSON 前先 URL 編碼，頁面收到後解碼（Make 沒有 JSON 跳脫函式）"""
    return "{{encodeURL(" + inner(expr) + ")}}"


def cut(field, n):
    return "{{substring(" + field + "; 0; " + str(n) + ")}}"


def pick(field, options, fallback):
    """頁面送來的值只接受固定選項，其他值改成 fallback（避免在 Notion 新增奇怪的選項）"""
    return '{{if(contains(split("' + ",".join(options) + '"; ","); ' + field + "); " + field + "; " + fallback + ")}}"


def fv(k, typ, v):
    return {"key": k, "type": typ, "value": v}


def now(k, start="{{now}}"):
    return {"key": k, "type": "date", "date": {"start": start, "includeTime": True}}


def alias_csv(role_expr):
    """角色 → 這個角色涵蓋的執行職掌（逗號分隔）"""
    return ("switch(" + inner(role_expr) + "; "
            + "; ".join(f'"{r}"; "{",".join(ALIASES[r])}"' for r in ROLES) + '; "")')


def role_of(executor_expr):
    """執行職掌 → 角色（舊職稱也對應得到）"""
    return ("{{switch(" + inner(executor_expr) + "; "
            + "; ".join(f'"{a}"; "{r}"' for r in ROLES for a in ALIASES[r]) + '; "")}}')


def prop(name, typ):
    return f"{name} |&*^%$#@| {typ}"


class B:
    """藍圖組裝器：依序配發模組編號和畫布座標。"""

    def __init__(self, start=100):
        self.next_id = start
        self.y = 0

    def nid(self):
        self.next_id += 1
        return self.next_id

    def meta(self, name, params=None):
        self.y += 150
        m = {"designer": {"x": 900, "y": self.y, "name": name}}
        if params:
            m["parameters"] = params
        return m

    def ignore(self):
        return {"id": self.nid(), "module": "builtin:Ignore", "version": 1, "mapper": None,
                "metadata": {"designer": {"x": 1200, "y": self.y}}}

    def respond(self, name, body, status="200"):
        return {"id": self.nid(), "module": "gateway:WebhookRespond", "version": 1, "parameters": {},
                "mapper": {"status": status, "body": body, "headers": [
                    {"key": "Content-Type", "value": "application/json; charset=utf-8"},
                    {"key": "Access-Control-Allow-Origin", "value": ORIGIN}]},
                "metadata": self.meta(name)}

    def notion(self, module, name, mapper, onerror=None):
        d = {"id": self.nid(), "module": f"notion:{module}", "version": 1, "mapper": mapper,
             "metadata": self.meta(name, NOTION_META), "parameters": {"__IMTCONN__": CONN_NOTION}}
        if onerror:
            d["onerror"] = onerror
        return d

    def search(self, name, ds, groups, limit="1"):
        return self.notion("searchObjects1", name, {"limit": limit, "select": "data_source_item", "data_source": ds,
                                                     "filter": groups})

    def get(self, name, page, onerror=None):
        return self.notion("getADatabaseItem", name, {"page": page, "getBy": "data_source", "select": "map"}, onerror)

    def create(self, name, fields, ds=DS_MEMBER):
        return self.notion("createDataSourceItem", name, {"fields": fields, "select": "map", "data_source": ds})

    def update(self, name, page, fields, ds=DS_MEMBER):
        return self.notion("updateADatabaseItem", name,
                           {"page": page, "fields": fields, "select": "map", "updateBy": "data_source", "data_source": ds})

    def notion_api(self, name, url, method, body, onerror=None):
        return self.notion("makeApiCall", name, {
            "url": url, "method": method, "version": "2022-06-28",
            "headers": [{"key": "Content-Type", "value": "application/json"}], "qs": [], "body": body}, onerror)

    def drive_upload(self, name, filename, b64_field):
        return {"id": self.nid(), "module": "google-drive:uploadAFile", "version": 4,
                "parameters": {"__IMTCONN__": CONN_DRIVE},
                "mapper": {"select": "map", "folderId": DRIVE_FOLDER, "filename": filename,
                           "data": "{{toBinary(" + b64_field + "; \"base64\")}}", "convert": False},
                "metadata": self.meta(name, [{"name": "__IMTCONN__", "type": "account:google-restricted,google-drive",
                                              "label": "Connection", "required": True}])}

    def line(self, name, url, method="GET", body=None, onerror=None):
        mapper = {"url": url, "method": method, "headers": []}
        if body is not None:
            # 字串＝已經組好的 JSON（裡面有 Make 運算式，不能再被 json.dumps 加上跳脫）
            mapper["body"] = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)
            mapper["headers"] = [{"key": "Content-Type", "value": "application/json"}]
        d = {"id": self.nid(), "module": "line:makeApiCall", "version": 1, "parameters": {"__IMTCONN__": CONN_LINE},
             "mapper": mapper, "metadata": self.meta(name, LINE_META)}
        if onerror:
            d["onerror"] = onerror
        return d

    def setvars(self, name, variables):
        """設定變數：用來組合文字（Make 的運算式沒有字串相加，要在一般欄位裡用 {{ }} 拼起來）"""
        return {"id": self.nid(), "module": "util:SetVariables", "version": 1, "parameters": {},
                "mapper": {"variables": [{"name": k, "value": v} for k, v in variables.items()], "scope": "roundtrip"},
                "metadata": self.meta(name)}

    def router(self, name, routes):
        mid = self.nid()
        rs = []
        for f, mods in routes:
            mods = [dict(m) for m in mods]
            mods[0]["filter"] = f
            rs.append({"flow": mods})
        self.y += 150
        return {"id": mid, "module": "builtin:BasicRouter", "version": 1, "mapper": None,
                "metadata": {"designer": {"x": 600, "y": self.y, "name": name}}, "routes": rs}

    def to_json(self, name, feeder, fields, keep=None):
        """彙整成 JSON 陣列。keep 是條件運算式（不含 {{}}）：不符合的資料列各欄位留空，頁面會略過。
        不用篩選擋掉資料列，因為全部被擋掉時彙整模組不會輸出，webhook 就收不到回應。"""
        value = (lambda k: f"{{{{{feeder}.{k}}}}}") if keep is None else (lambda k: f"{{{{if({keep}; {feeder}.{k}; null)}}}}")
        agg = {"id": self.nid(), "module": "builtin:BasicAggregator", "version": 1, "parameters": {"feeder": feeder},
               "mapper": {k: value(k) for k in fields}, "metadata": self.meta(f"彙整{name}")}
        js = {"id": self.nid(), "module": "json:TransformToJSON", "version": 1, "parameters": {"space": ""},
              "mapper": {"object": f"{{{{{agg['id']}.array}}}}"}, "metadata": self.meta(f"{name}轉成 JSON")}
        return [agg, js], f"{{{{{js['id']}.json}}}}"


def webhook(hook, name):
    return {"id": 1, "module": "gateway:CustomWebHook", "version": 1, "parameters": {"hook": hook, "maxResults": 1},
            "mapper": {}, "metadata": {"designer": {"x": -300, "y": 0, "name": name}, "parameters": [
                {"name": "hook", "type": "hook:gateway-webhook", "label": "Webhook", "required": True},
                {"name": "maxResults", "type": "number", "label": "Maximum number of results"}]}}


def blueprint(name, flow, instant=True):
    return {"name": PREFIX + name, "flow": flow, "metadata": {
        "instant": instant, "version": 1, "designer": {"orphans": []},
        "scenario": {"dlq": True, "slots": None, "dataloss": False, "maxErrors": 3, "autoCommit": True,
                     "roundtrips": 1, "sequential": False, "confidential": False,
                     "freshVariables": False, "autoCommitTriggerLast": True}}}


# ---- 選單 ----
def link_menu(b, uid, page, menu, label):
    """綁定選單：先用別名取得選單編號，再綁給這個人；成功後把「目前選單」寫回 Notion。"""
    alias = b.line(f"取得{menu}選單編號（{label}）", f"/v2/bot/richmenu/alias/{MENUS[menu][0]}", onerror=[b.ignore()])
    return [alias,
            b.line(f"綁定{menu}選單（{label}）", f"/v2/bot/user/{uid}/richmenu/{{{{{alias['id']}.body.richMenuId}}}}", "POST"),
            b.update(f"記下目前選單：{menu}（{label}）", page, [fv("目前選單", "select", menu), now("選單同步時間")])]


def unlink_menu(b, uid, page, label):
    """解除個人綁定，回到預設的訪客選單（本來就沒有綁定時 LINE 會回錯誤，略過）"""
    return [b.update(f"記下目前選單：訪客（{label}）", page, [fv("目前選單", "select", "訪客"), now("選單同步時間")]),
            b.line(f"解除個人選單（{label}）", f"/v2/bot/user/{uid}/richmenu", "DELETE", onerror=[b.ignore()])]


def push(b, name, to, text):
    return b.line(name, "/v2/bot/message/push", "POST", {"to": to, "messages": [{"type": "text", "text": text}]},
                  onerror=[b.ignore()])


# 主動推播會扣 LINE 官方帳號每月免費訊息額度。2026-10-22 決定這一版先不推播（成員自己打開頁面看進度），
# 設定檔 line.push 改成 true 就會恢復：新申請、申請結果、送審、審核結果四種通知
PUSH = bool(LN.get("push", False))


def if_push(*mods):
    return list(mods) if PUSH else []


# ---- 專案進度推播（📣 專案推播）：各職掌各狀態的件數，和上次推播比「舊→新」，推給專案全體已核准成員 ----
PUSH_STATUSES = ["尚未開始", "執行創作中", "待審核", "退回修改", "已核准"]
PUSH_LABEL = {"執行創作中": "執行中"}
PUSH_COMBOS = [(r, s) for r in ROLES for s in PUSH_STATUSES]   # 「上次數字」依這個順序存成逗號分隔


def raw_json(obj, exprs):
    """組 JSON：值是 "__k__" 的地方換成 Make 運算式（數字、布林不能加引號）"""
    s = json.dumps(obj, ensure_ascii=False)
    for k, v in exprs.items():
        s = s.replace(f'"__{k}__"', v)
    return s


def progress_push(b, pid, label, only_instant=False):
    """pid：專案 page id 的運算式。only_instant：即刻推播沒開就停（交件、審核後用）。
    數字來源：任務的公式「推播碼」＝|職掌:狀態|，串起來後用 split 數出現次數。"""
    q = lambda name, db, flt_: b.notion_api(name, f"/v1/databases/{db}/query", "POST",
                                            json.dumps({"filter": flt_, "page_size": 100}, ensure_ascii=False))
    st = q(f"讀推播設定（{label}）", DB_PUSH, {"property": "專案", "relation": {"contains": pid}})
    ST = st["id"]
    tk = q(f"讀專案任務（{label}）", DB_TASK, {"and": [{"property": "所屬專案", "relation": {"contains": pid}},
                                                   {"property": "範本任務", "checkbox": {"equals": False}}]})
    pp = q(f"讀專案成員（{label}）", DB_ASSIGN, {"and": [{"property": "專案", "relation": {"contains": pid}},
                                                     {"property": "狀態", "select": {"equals": "已核准"}}]})
    first_of = lambda m, path: "first(map(" + f"{m}.body.results" + '; "' + path + '"))'
    a = b.setvars(f"推播資料（{label}）", {
        "codes": "{{join(map(" + f"{tk['id']}.body.results" + '; "properties.推播碼.formula.string"); "")}}',
        "snap": "{{ifempty(" + first_of(ST, "properties.數字碼.formula.string") + '; "")}}',
        "page": "{{" + first_of(ST, "id") + "}}",
        "name": "{{" + first_of(ST, "properties.專案名.formula.string") + "}}",
        "ids": '{{join(deduplicate(remove(map(' + f"{pp['id']}.body.results" + '; "properties.推播對象.formula.string"); "")); ",")}}'})
    A = str(a["id"])
    gate = [c("{{" + first_of(ST, "id") + "}}", "exist")]
    if only_instant:
        gate.append(c("{{" + first_of(ST, "properties.即刻推播.checkbox") + "}}", "text:equal", "true"))
    a["filter"] = flt("有推播設定" + ("且開了即刻推播" if only_instant else ""), [gate])
    cnt = lambda r, s: f'(length(split({A}.codes; "|{r}:{s}|")) - 1)'
    nv = {}
    for i, (r, s) in enumerate(PUSH_COMBOS, 1):
        nv[f"n{i}"] = "{{" + cnt(r, s) + "}}"
        # 第一次推播沒有上次數字：舊值當成和新值一樣（只列現況，不顯示變化）
        nv[f"o{i}"] = "{{if(" + A + '.snap = ""; ' + cnt(r, s) + "; parseNumber(get(split(" + A + '.snap; ","); ' + str(i) + ")))}}"
    n = b.setvars(f"推播件數（{label}）", nv)
    N = n["id"]
    idx = {k: i for i, k in enumerate(PUSH_COMBOS, 1)}
    nn, oo = (lambda r, s: f"{N}.n{idx[(r, s)]}"), (lambda r, s: f"{N}.o{idx[(r, s)]}")
    snap_new = ",".join("{{" + f"{N}.n{i}" + "}}" for i in range(1, len(PUSH_COMBOS) + 1))
    t = b.setvars(f"推播總計（{label}）", {
        "snap": snap_new,
        "total": "{{" + " + ".join(nn(r, s) for r, s in PUSH_COMBOS) + "}}",
        "done": "{{" + " + ".join(nn(r, "已核准") for r in ROLES) + "}}",
        "done_old": "{{" + " + ".join(oo(r, "已核准") for r in ROLES) + "}}",
        **{f"t{j}": "{{" + " + ".join(nn(r, s) for s in PUSH_STATUSES) + "}}" for j, r in enumerate(ROLES)}})
    T = str(t["id"])
    lines = []
    for j, r in enumerate(ROLES):
        on = f"{T}.t{j} > 0"
        seg = ("{{if(" + on + '; newline; "")}}{{if(' + on + '; "• ' + r + ' 已核准 "; "")}}{{if(' + on + "; " + nn(r, "已核准") + '; "")}}'
               + "{{if(" + on + '; "／"; "")}}{{if(' + on + f"; {T}.t{j}" + '; "")}}')
        for s in PUSH_STATUSES:
            ch = f"{nn(r, s)} != {oo(r, s)}"
            seg += ("{{if(" + ch + '; "｜' + PUSH_LABEL.get(s, s) + ' "; "")}}{{if(' + ch + "; " + oo(r, s) + '; "")}}'
                    + "{{if(" + ch + '; "→"; "")}}{{if(' + ch + "; " + nn(r, s) + '; "")}}')
        lines.append(seg)
    msg = ("📣 {{" + A + ".name}}｜進度 " + ('{{formatDate(now; "M/D HH:mm"; "Asia/Taipei")}}')
           + "\n全案 已核准 {{if(" + T + ".done != " + T + ".done_old; " + T + '.done_old; "")}}{{if(' + T + ".done != "
           + T + '.done_old; "→"; "")}}{{' + T + ".done}}／{{" + T + ".total}} 項"
           + "".join(lines)
           + "\n{{if(" + A + '.snap = ""; "（第一次推播，之後會標出和上次相比的變化）"; if(' + T + ".snap = " + A
           + '.snap; "和上次推播相比沒有變化"; "｜後面是「上次→現在」"))}}'
           + "\n\n打開選單看詳細進度：" + LIFF)
    m = b.setvars(f"推播訊息（{label}）", {"msg": msg})
    save = b.notion_api(f"記下這次推播的數字（{label}）", "/v1/pages/{{" + A + ".page}}", "PATCH", raw_json(
        {"properties": {"上次數字": {"rich_text": [{"text": {"content": "__s__"}}]},
                        "上次推播時間": {"date": {"start": "__t__"}}}}, {"s": '"{{' + T + '.snap}}"', "t": '"{{now}}"'}))
    feed = {"id": b.nid(), "module": "builtin:BasicFeeder", "version": 1,
            "mapper": {"array": "{{split(" + A + '.ids; ",")}}'}, "metadata": b.meta(f"逐一推給成員（{label}）")}
    feed["filter"] = flt("有成員可推", [[c("{{" + A + ".ids}}", "exist")]])
    send = b.line(f"推播進度（{label}）", "/v2/bot/message/push", "POST",
                  # 訊息裡的換行改成 JSON 的 \n（Make 沒有 JSON 跳脫函式；訊息只有固定文字、數字與專案名稱）
                  '{"to":"{{' + str(feed["id"]) + '.value}}","messages":[{"type":"text","text":"{{replace('
                  + str(m["id"]) + '.msg; newline; "\\n")}}"}]}', onerror=[b.ignore()])
    return [st, tk, pp, a, n, t, m, save, feed, send]


# ==== 風雅存｜LIFF API ====
def build_api():
    b = B()
    respond = b.respond

    # LIFF：先驗證 Access Token（屬於本系統的 LINE Login channel），再取得使用者編號
    def line_get(mid, url, name, headers=()):
        return {"id": mid, "module": "http:ActionSendData", "version": 3, "parameters": {"handleErrors": False},
                "mapper": {"url": url, "method": "get", "serializeUrl": False, "shareCookies": False,
                           "parseResponse": True, "headers": list(headers), "qs": [], **HTTP_DEFAULTS},
                "metadata": {"designer": {"x": 0 if mid == 2 else 150, "y": 0 if mid == 2 else 150, "name": name}},
                "onerror": [respond(f"回傳驗證失敗（{name}）", '{"ok":false,"error":"auth"}', "401"), b.ignore()]}
    verify = line_get(2, "https://api.line.me/oauth2/v2.1/verify?access_token={{encodeURL(1.t)}}", "向 LINE 驗證 Access Token")
    profile = line_get(4, "https://api.line.me/v2/profile", "向 LINE 取得使用者編號",
                       [{"name": "Authorization", "value": "Bearer {{1.t}}"}])
    UID, DISPLAY = "{{4.data.userId}}", "{{4.data.displayName}}"

    # 人員名冊：一人一筆，記 LINE 身分、目前綁定的選單；狀態「停用」時一律當訪客
    w = b.search("找我的名冊", DS_MEMBER, [[c(prop("LINE User ID", "rich_text"), "text:equals", UID)]])
    W = w["id"]
    w_page, w_state = f"{{{{{W}.id}}}}", sp(W, "狀態", ".name")
    w_menu, w_name = sp(W, "目前選單", ".name"), sp(W, "姓名", "[].plain_text")
    exist, none = c(w_page, "exist"), c(w_page, "notexist")
    forbidden = lambda name: respond(name, '{"ok":false,"error":"forbidden"}', "403")

    # 我在各專案的角色（🧩 專案角色）。用 Notion API 查：沒有資料時也會回傳空陣列，流程不會停住。
    # 權限碼是 Notion 公式「狀態:專案:角色」，串成 |已核准:專案:製片人|已核准:專案:導演| 這樣的一串，之後用 contains 判斷
    mine = b.notion_api("查我的專案角色", f"/v1/databases/{DB_ASSIGN}/query", "POST", json.dumps(
        {"filter": {"property": "LINE User ID", "rich_text": {"equals": UID}}, "page_size": 100}, ensure_ascii=False))
    M = mine["id"]
    ctx = b.setvars("整理我的角色", {
        "keys": "|{{replace(join(map(" + f"{M}.body.results" + '; "properties.權限碼.formula.string"); "|"); "-"; "")}}|',
        "roles": "{{join(map(" + f"{M}.body.results" + '; "properties.已核准角色.formula.string"); ",")}}',
        # 平台管理者（名冊勾選）：核准所有專案的所有申請（含製片人），看得到所有專案
        "adm": '{{if(' + f"{W}.properties_value.`平台管理者`" + '; "yes"; "no")}}'})
    V = ctx["id"]
    KEYS, ROLESET, ADM = f"{V}.keys", f"{V}.roles", f"{V}.adm"
    is_adm = ADM + ' = "yes"'
    no_role = 'replace(' + ROLESET + '; ","; "") = ""'
    # 平台管理者沒有任何角色也算成員；核准成員時也當成製片人
    roleish = "{{if(" + is_adm + '; "平台管理者"; replace(' + ROLESET + '; ","; ""))}}'
    has_role, lacks_role = c(roleish, "exist"), c(roleish, "notexist")
    producerish = "{{if(" + is_adm + '; "製片人"; ' + ROLESET + ")}}"
    active, disabled = c(w_state, "text:notequal", "停用"), c(w_state, "text:equal", "停用")
    is_member = [has_role, active]
    is_producer = [c(producerish, "text:contain", "製片人"), active]
    not_member = [[lacks_role], [disabled]]
    not_producer = [[c(producerish, "text:notcontain", "製片人")], [disabled]]

    # ---- me：我的身分與各專案角色（順便校正選單）。先回應頁面再校正選單，換選單出錯也不會讓頁面卡住 ----
    expect = ('{{if(' + inner(w_state) + ' = "停用"; "訪客"; if(' + is_adm + '; "製片人"; if(contains(' + ROLESET + '; "製片人"); "製片人"; '
              'if(contains(' + ROLESET + '; "導演"); "導演"; if(contains(' + ROLESET + '; "副製片"); "導演"; '
              'if(' + no_role + '; "訪客"; "團隊成員"))))))}}')
    state_code = ('{{if(' + inner(w_state) + ' = "停用"; "disabled"; if(' + is_adm + '; "member"; if(' + no_role + '; '
                  'if(contains(' + KEYS + '; "|審核中:"); "pending"; if(contains(' + KEYS + '; "|已退回:"); "rejected"; "guest")); '
                  '"member")))}}')
    me_body = ('{"ok":true,"state":"' + state_code + '","name":"' + enc(w_name) + '","line":"' + enc(DISPLAY)
               + '","keys":"{{' + KEYS + '}}","roles":"{{' + ROLESET + '}}","admin":"{{' + ADM + '}}"}')
    guest_body = '{"ok":true,"state":"guest","name":"","line":"' + enc(DISPLAY) + '","keys":"","roles":""}'
    me_routes = [
        (flt("還沒有名冊", [[none]]), [
            b.create("新增訪客", [fv("姓名", "title", "（LINE）" + DISPLAY), fv("狀態", "select", "訪客"),
                              fv("LINE 顯示名稱", "rich_text", DISPLAY), fv("LINE User ID", "rich_text", UID),
                              fv("好友狀態", "select", "好友中"), fv("目前選單", "select", "訪客")]),
            respond("回傳訪客", guest_body)]),
        (flt("選單正確", [[exist, c(expect, "text:equal", w_menu)]]), [respond("回傳我的身分", me_body)]),
        (flt("應該是訪客選單", [[exist, c(expect, "text:equal", "訪客"), c(w_menu, "text:notequal", "訪客")]]), [
            respond("回傳我的身分（校正成訪客選單）", me_body), *unlink_menu(b, UID, w_page, "校正")]),
    ]
    for menu in ("團隊成員", "導演", "製片人"):
        me_routes.append((flt(f"應該是{menu}選單", [[exist, c(expect, "text:equal", menu), c(w_menu, "text:notequal", menu)]]), [
            respond(f"回傳我的身分（校正成{menu}選單）", me_body), *link_menu(b, UID, w_page, menu, "校正")]))
    me_flow = [b.router("我的身分（順便校正選單）", me_routes)]

    # ---- projects：可以申請的專案（多專案任務總管理） ----
    plist = b.search("找專案（申請用）", DS_PROJECT, [], limit="50")
    pl_mods, pl_json = b.to_json("專案（申請用）", plist["id"], ["id", "properties_value"])
    projects_flow = [plist, *pl_mods, respond("回傳專案清單", '{"ok":true,"projects":' + pl_json + "}")]

    # ---- apply：申請加入某個專案的某個角色（製片人除外），由該專案的製片人核准。可以申請多筆 ----
    role_v = pick("1.role", APPLY_ROLES, "null")

    def new_application(label, person_id):
        return b.create(f"新增申請（{label}）", [
            fv("紀錄", "title", cut("1.name", 40) + "｜" + cut("1.pname", 60) + "｜" + role_v),
            fv("成員", "relation", "{{split(" + person_id + '; ",")}}'), fv("LINE User ID", "rich_text", UID),
            fv("專案", "relation", '{{split(1.project; ",")}}'), fv("角色", "select", role_v),
            fv("狀態", "select", "審核中"), now("申請時間"), fv("備註", "rich_text", cut("1.note", 300))], ds=DS_ASSIGN)
    person = b.create("新增名冊（申請）", [fv("姓名", "title", cut("1.name", 40)), fv("狀態", "select", "訪客"),
                                        fv("LINE 顯示名稱", "rich_text", DISPLAY), fv("LINE User ID", "rich_text", UID),
                                        fv("好友狀態", "select", "好友中"), fv("目前選單", "select", "訪客")])
    # 同一個專案的同一個角色已經有人核准：不能再申請（一個角色一個人）
    ar = b.setvars("申請的角色", {"r": role_v})
    taken_q = b.notion_api("這個角色有人了嗎（申請）", f"/v1/databases/{DB_ASSIGN}/query", "POST", json.dumps({"filter": {"and": [
        {"property": "專案", "relation": {"contains": "{{1.project}}"}},
        {"property": "角色", "select": {"equals": f"{{{{{ar['id']}.r}}}}"}},
        {"property": "狀態", "select": {"equals": "已核准"}}]}, "page_size": 1}, ensure_ascii=False))
    taken_id = "{{first(map(" + f"{taken_q['id']}.body.results" + '; "id"))}}'
    apply_flow = [ar, taken_q, b.router("這個角色有人了嗎", [
      (flt("已經有人", [[c(taken_id, "exist")]]), [respond("回傳角色已有人", '{"ok":false,"error":"taken"}', "409")]),
      (flt("還沒有人", [[c(taken_id, "notexist")]]), [b.router("申請加入", [
        (flt("新申請（還沒有名冊）", [[none]]), [
            person, new_application("新成員", f"{person['id']}.id"), respond("回傳已送出申請（新）", '{"ok":true}')]),
        (flt("已有名冊", [[exist, active]]), [
            b.update("更新姓名", w_page, [fv("姓名", "title", cut("1.name", 40)), fv("LINE 顯示名稱", "rich_text", DISPLAY)]),
            new_application("已有名冊", f"{W}.id"), respond("回傳已送出申請", '{"ok":true}')]),
        (flt("已停用", [[exist, disabled]]), [forbidden("回傳沒有權限（申請）")]),
    ])])])]

    # ---- tasks：我參與的專案裡、我看得到的任務 ----
    # 製片人、副製片、導演看得到該專案全部任務；其他角色只看得到執行職掌是自己角色的任務。在 Make 端篩，不靠頁面
    not_template = c(prop("範本任務", "checkbox"), "checkbox:equals", "false")
    tasks = b.search("找任務", DS_TASK, [[not_template]], limit="500")
    T = tasks["id"]
    # 誰看得到：任務的公式「可見碼」＝本人職掌、製片人、副製片、導演四組權限碼（逗號分隔），比對我的權限碼。
    # 判斷寫在彙整模組裡，不用逐筆的變數模組（2026-11-02 前每次開頁面要 100 多個 operation）
    # 公式欄在搜尋結果裡可能是字串或 {string: …}，兩種都接受
    vcode = f"ifempty({T}.properties_value.`可見碼`.string; {T}.properties_value.`可見碼`)"
    vis = lambda i: f'contains({KEYS}; get(split({vcode}; ","); {i}))'
    keep = f"if({is_adm}; true; if({vis(1)}; true; if({vis(2)}; true; if({vis(3)}; true; {vis(4)}))))"
    t_mods, t_json = b.to_json("任務", T, ["id", "properties_value"], keep)
    projects = b.search("找專案", DS_PROJECT, [], limit="50")
    p_mods, p_json = b.to_json("專案", projects["id"], ["id", "properties_value"])
    tasks_flow = [tasks, *t_mods, projects, *p_mods,
                  respond("回傳任務", '{"ok":true,"tasks":' + t_json + ',"projects":' + p_json + "}")]

    # ---- pending：審核中的申請（頁面只顯示自己當製片人的專案；核准時再檢查一次） ----
    waiting = b.notion_api("找審核中的申請", f"/v1/databases/{DB_ASSIGN}/query", "POST", json.dumps(
        {"filter": {"property": "狀態", "select": {"equals": "審核中"}}, "page_size": 100}, ensure_ascii=False))
    wj = {"id": b.nid(), "module": "json:TransformToJSON", "version": 1, "parameters": {"space": ""},
          "mapper": {"object": f"{{{{{waiting['id']}.body.results}}}}"}, "metadata": b.meta("申請轉成 JSON")}
    pending_flow = [waiting, wj, respond("回傳待核准名單", '{"ok":true,"apps":' + f"{{{{{wj['id']}.json}}}}" + "}")]

    # ---- links：專案雲端資料夾（IP 資料庫的七個分類）。只回傳我有參與（任一已核准角色）的專案 ----
    ip = b.search("找雲端資料夾", DS_IP, [], limit="200")
    I = ip["id"]
    # 公式「可見碼」＝|已核准:專案:，我的權限碼裡有就是這個專案的成員
    l_mods, l_json = b.to_json("雲端資料夾", I, ["id", "properties_value"], f"if({is_adm}; true; contains({KEYS}; ifempty({I}.properties_value.`可見碼`.string; {I}.properties_value.`可見碼`)))")
    links_flow = [ip, *l_mods, respond("回傳雲端資料夾", '{"ok":true,"links":' + l_json + "}")]

    # ---- push_get／push_set／push_now：專案進度推播的設定，只有該專案的製片人、導演能讀、改、試推 ----
    PID = "{{1.pid}}"
    push_q = lambda name: b.notion_api(name, f"/v1/databases/{DB_PUSH}/query", "POST", json.dumps(
        {"filter": {"property": "專案", "relation": {"contains": PID}}, "page_size": 1}, ensure_ascii=False))
    pg = push_q("讀推播設定")
    pgj = {"id": b.nid(), "module": "json:TransformToJSON", "version": 1, "parameters": {"space": ""},
           "mapper": {"object": f"{{{{{pg['id']}.body.results}}}}"}, "metadata": b.meta("推播設定轉成 JSON")}
    push_get_flow = [pg, pgj, respond("回傳推播設定", '{"ok":true,"push":' + f"{{{{{pgj['id']}.json}}}}" + "}")]
    ps = push_q("找推播設定（修改）")
    PS = ps["id"]
    hour_v = "{{parseNumber(" + inner(pick("1.hour", [str(h) for h in range(24)], '"9"')) + ")}}"
    on = lambda f: '{{if(1.' + f + ' = "1"; true; false)}}'
    props = {"每日推播": {"checkbox": "__d__"}, "推播時間": {"number": "__h__"}, "即刻推播": {"checkbox": "__i__"},
             "設定人": {"rich_text": [{"text": {"content": "__w__"}}]}, "設定時間": {"date": {"start": "__t__"}}}
    vals = {"d": on("daily"), "h": hour_v, "i": on("instant"), "w": '"' + w_name + '"', "t": '"{{now}}"'}
    ps_id = "{{first(map(" + f"{PS}.body.results" + '; "id"))}}'
    push_set_flow = [ps, b.router("新增或修改推播設定", [
        (flt("修改", [[c(ps_id, "exist")]]), [
            b.notion_api("修改推播設定", "/v1/pages/" + ps_id, "PATCH", raw_json({"properties": props}, vals)),
            respond("回傳已修改推播設定", '{"ok":true}')]),
        (flt("新增", [[c(ps_id, "notexist")]]), [
            b.notion_api("新增推播設定", "/v1/pages", "POST", raw_json({"parent": {"database_id": DB_PUSH}, "properties": {
                **props, "名稱": {"title": [{"text": {"content": "__n__"}}]}, "專案": {"relation": [{"id": "__p__"}]}}},
                {**vals, "n": '"' + cut("1.pname", 80) + '"', "p": '"' + PID + '"'})),
            respond("回傳已新增推播設定", '{"ok":true}')]),
    ])]
    push_now_flow = [respond("回傳已送出推播", '{"ok":true}'), *progress_push(b, PID, "現在推一次")]

    # ---- setup：建立專案工作（只有平台管理者）。新專案在 Notion 建好頁面後，從「📐 動畫專案範本任務」複製任務，
    #      並建好 IP 資料庫七個分類、推播設定（關閉）。這個專案已經有任務就不做，避免重複 ----
    has = b.notion_api("這個專案有任務了嗎", f"/v1/databases/{DB_TASK}/query", "POST", json.dumps(
        {"filter": {"property": "所屬專案", "relation": {"contains": PID}}, "page_size": 1}, ensure_ascii=False))
    has_id = "{{first(map(" + f"{has['id']}.body.results" + '; "id"))}}'
    page = lambda name, db, props, vals: b.notion_api(name, "/v1/pages", "POST", raw_json(
        {"parent": {"database_id": db}, "properties": props}, vals))
    pname = '"' + cut("1.pname", 80) + '"'
    ip_rows = [page(f"建立 IP 分類：{n}", DB_IP, {"名稱": {"title": [{"text": {"content": n}}]}, "專案": {"relation": [{"id": "__p__"}]},
                                                 "排序": {"number": i}}, {"p": '"' + PID + '"'}) for i, n in enumerate(IP_FOLDERS, 1)]
    push_row = page("建立推播設定（關閉）", DB_PUSH, {"名稱": {"title": [{"text": {"content": "__n__"}}]}, "專案": {"relation": [{"id": "__p__"}]},
                                              "每日推播": {"checkbox": False}, "推播時間": {"number": 9}, "即刻推播": {"checkbox": False}},
                     {"n": pname, "p": '"' + PID + '"'})
    tpl = b.notion_api("讀範本任務", f"/v1/databases/{DB_TEMPLATE}/query", "POST", json.dumps({"page_size": 100}, ensure_ascii=False))
    tf = {"id": b.nid(), "module": "builtin:BasicFeeder", "version": 1, "mapper": {"array": f"{{{{{tpl['id']}.body.results}}}}"},
          "metadata": b.meta("逐一複製範本任務")}
    TF = tf["id"]
    txt = lambda k, t: "{{join(map(" + f"{TF}.properties.`{k}`.{t}" + '; "plain_text"); "")}}'
    sel_v = lambda k: "{{" + f"{TF}.properties.`{k}`.select.name" + "}}"
    copy = b.create("建立這個專案的任務", [
        fv("任務名稱", "title", txt("任務名稱", "title")), fv("序號", "number", "{{" + f"{TF}.properties.`序號`.number" + "}}"),
        fv("階段", "select", sel_v("階段")), fv("工作流程", "select", sel_v("工作流程")), fv("執行職掌", "select", sel_v("執行職掌")),
        fv("審核職掌", "select", sel_v("審核職掌")), fv("查核點", "rich_text", txt("查核點", "rich_text")),
        fv("狀態", "select", "尚未開始"), fv("所屬專案", "relation", '{{split(1.pid; ",")}}')], ds=DS_TASK)
    setup_flow = [has, b.router("這個專案有任務了嗎", [
        (flt("已經有任務", [[c(has_id, "exist")]]), [respond("回傳已有任務", '{"ok":false,"error":"exists"}', "409")]),
        # 先回應頁面（複製 47 筆約要一分鐘），再建 IP 分類、推播設定，最後逐筆複製任務（放最後，後面的模組才不會每筆都跑）
        (flt("還沒有任務", [[c(has_id, "notexist")]]), [respond("回傳開始建立", '{"ok":true}'), *ip_rows, push_row, tpl, tf, copy]),
    ])]
    keys_t = "{{" + KEYS + "}}"
    can_push = [[c(keys_t, "text:contain", f"|已核准:{PID}:{r}|"), active] for r in ("製片人", "導演")] + [
        [c("{{" + ADM + "}}", "text:equal", "yes"), active]]
    no_push = [[c(keys_t, "text:notcontain", f"|已核准:{PID}:製片人|"), c(keys_t, "text:notcontain", f"|已核准:{PID}:導演|"),
                c("{{" + ADM + "}}", "text:notequal", "yes")], [disabled]]

    # ---- approve／reject：平台管理者處理所有申請；該專案的製片人處理製片人以外的申請。只處理「審核中」的申請 ----
    def target(label):
        t = b.get(f"讀申請（{label}）", "{{1.id}}",
                  onerror=[respond(f"回傳找不到申請（{label}）", '{"ok":false,"error":"bad_target"}', "409"), b.ignore()])
        T_ = t["id"]
        p = b.setvars(f"申請的專案（{label}）", {"p": "{{replace(first(map(" + f"{T_}.properties_value.`專案`" + '; "id")); "-"; "")}}'})
        code = b.setvars(f"製片人權限碼（{label}）", {"code": f"|已核准:{{{{{p['id']}.p}}}}:製片人|"})
        can = b.setvars(f"可否處理（{label}）", {"ok": "{{if(" + is_adm + '; "yes"; if(contains(' + KEYS + "; " + str(code["id"])
                                                + '.code); if(' + inner(sp(T_, "角色", ".name")) + ' = "製片人"; "no"; "yes"); "no"))}}'})
        CAN = f"{{{{{can['id']}.ok}}}}"
        ok = [c(sp(T_, "狀態", ".name"), "text:equal", "審核中"), c(CAN, "text:equal", "yes")]
        bad = [[c(sp(T_, "狀態", ".name"), "text:notequal", "審核中")], [c(CAN, "text:equal", "no")]]
        return [t, p, code, can], T_, ok, bad, p["id"]

    pre1, T1, ok1, bad1, P1 = target("核准")
    T1_page = f"{{{{{T1}.id}}}}"
    T1_uid = sp(T1, "LINE User ID", "[].plain_text")
    role = pick("1.role", APPLY_ROLES, sp(T1, "角色", ".name")[2:-2])
    applicant = b.get("讀申請人名冊", "{{first(map(" + f"{T1}.properties_value.`成員`" + '; "id"))}}')
    AP = applicant["id"]
    ap_menu = sp(AP, "目前選單", ".name")
    # 選單取最高的角色：已經是製片人或導演選單就不降級
    final = b.setvars("核准後的選單", {"menu": '{{if(' + inner(ap_menu) + ' = "製片人"; "製片人"; if(' + inner(role)
                                       + ' = "製片人"; "製片人"; if(' + inner(ap_menu)
                                       + ' = "導演"; "導演"; if(' + inner(role) + ' = "導演"; "導演"; if(' + inner(role)
                                       + ' = "副製片"; "導演"; "團隊成員")))))}}'})
    who = '{{if(' + is_adm + '; "平台管理者"; "製片人")}}'
    # 核准時角色可以改，所以用核准的角色再查一次有沒有人了
    rv = b.setvars("核准的角色", {"r": role})
    RV = str(rv["id"])
    dup = b.notion_api("這個角色有人了嗎（核准）", f"/v1/databases/{DB_ASSIGN}/query", "POST", json.dumps({"filter": {"and": [
        {"property": "專案", "relation": {"contains": f"{{{{{P1}.p}}}}"}},
        {"property": "角色", "select": {"equals": f"{{{{{RV}.r}}}}"}},
        {"property": "狀態", "select": {"equals": "已核准"}}]}, "page_size": 1}, ensure_ascii=False))
    dup_id = "{{first(map(" + f"{dup['id']}.body.results" + '; "id"))}}'
    # 製片人的申請只有平台管理者能核准（核准時把角色改成製片人也一樣）
    role_gate = "{{if(" + is_adm + '; "yes"; if(' + RV + '.r = "製片人"; "no"; "yes"))}}'
    role_ok, role_bad = c(role_gate, "text:equal", "yes"), c(role_gate, "text:equal", "no")
    FM = f"{{{{{final['id']}.menu}}}}"
    AP_page = f"{{{{{AP}.id}}}}"
    approve_route = [
        b.update("核准：設定角色", T1_page, [fv("狀態", "select", "已核准"), fv("角色", "select", role), now("核准時間"),
                                       fv("核准人", "rich_text", w_name), fv("核准身分", "select", who)], ds=DS_ASSIGN),
        respond("回傳已核准", '{"ok":true}'),
        applicant, final,
        b.update("申請人名冊改為已核准", AP_page, [fv("狀態", "select", "已核准")]),
        b.router("換選單", [
            (flt(f"換成{m}選單", [[c(FM, "text:equal", m), c(ap_menu, "text:notequal", m)]]), link_menu(b, T1_uid, AP_page, m, "核准"))
            for m in ("團隊成員", "導演", "製片人")]),
    ]
    approve_flow = [*pre1, rv, dup, b.router("可否核准", [
        (flt("可以核准", [ok1 + [c(dup_id, "notexist"), role_ok]]), approve_route),
        (flt("角色已有人", [[c(dup_id, "exist")]]), [respond("回傳角色已有人（核准）", '{"ok":false,"error":"taken"}', "409")]),
        (flt("不能核准", bad1 + [[role_bad]]), [respond("回傳不能核准", '{"ok":false,"error":"bad_target"}', "409")]),
    ])]

    pre2, T2, ok2, bad2, _ = target("退回")
    reject_flow = [*pre2, b.router("可否退回", [
        (flt("可以退回", [ok2]), [
            b.update("退回申請", f"{{{{{T2}.id}}}}", [fv("狀態", "select", "已退回"), fv("核准人", "rich_text", w_name),
                                                  now("核准時間"), fv("核准身分", "select", who)], ds=DS_ASSIGN),
            respond("回傳已退回", '{"ok":true}')]),
        (flt("不能退回", bad2), [respond("回傳不能退回", '{"ok":false,"error":"bad_target"}', "409")]),
    ])]

    # ==== 任務明細、交件、審核：依「我在這個專案的角色」判斷 ====
    creator_titles = ",".join(a for r in CREATORS for a in ALIASES[r])

    def read_task(label):
        g = b.get(f"讀任務（{label}）", "{{1.id}}",
                  onerror=[respond(f"回傳找不到任務（{label}）", '{"ok":false,"error":"not_found"}', "404"), b.ignore()])
        G = g["id"]
        executor = sp(G, "執行職掌", ".name")
        v = b.setvars(f"任務的專案與角色（{label}）", {
            "p": "{{replace(first(map(" + f"{G}.properties_value.`所屬專案`" + '; "id")); "-"; "")}}',
            "r": role_of(executor),
            # 總監的工作由導演審核；導演、副製片、製片人的工作由製片人審核
            "rev": '{{if(contains("' + creator_titles + '"; ' + inner(executor) + '); "導演"; "製片人")}}'})
        Vt = v["id"]
        k = b.setvars(f"任務的權限碼（{label}）", {kk: f"|已核准:{{{{{Vt}.p}}}}:{vv}|" for kk, vv in
                                              (("own", f"{{{{{Vt}.r}}}}"), ("rv", f"{{{{{Vt}.rev}}}}"),
                                               ("m1", "製片人"), ("m2", "副製片"), ("m3", "導演"))})
        K = k["id"]
        yes = lambda key: f'{{{{if(contains({KEYS}; {K}.{key}); "yes"; "no")}}}}'
        mgr = (f'{{{{if(contains({KEYS}; {K}.m1); "yes"; if(contains({KEYS}; {K}.m2); "yes"; '
               f'if(contains({KEYS}; {K}.m3); "yes"; "no")))}}}}')
        return [g, v, k], G, {"own": yes("own"), "rev_ok": yes("rv"), "mgr": mgr, "p": f"{{{{{Vt}.p}}}}",
                              "role": f"{{{{{Vt}.r}}}}", "rev": f"{{{{{Vt}.rev}}}}"}

    # ---- task：任務明細與審核紀錄。自己的工作、審核者、製片人／副製片／導演看得到 ----
    pre_t, G1, f1 = read_task("明細")
    logs = b.notion_api("查這個任務的審核紀錄", f"/v1/databases/{DB_REVIEW}/query", "POST", json.dumps({
        "filter": {"property": "任務", "relation": {"contains": f"{{{{{G1}.id}}}}"}},
        "sorts": [{"timestamp": "created_time", "direction": "descending"}], "page_size": 30}, ensure_ascii=False))
    tj = {"id": b.nid(), "module": "json:TransformToJSON", "version": 1, "parameters": {"space": ""},
          "mapper": {"object": f"{{{{{G1}.properties_value}}}}"}, "metadata": b.meta("任務轉成 JSON")}
    lj = {"id": b.nid(), "module": "json:TransformToJSON", "version": 1, "parameters": {"space": ""},
          "mapper": {"object": f"{{{{{logs['id']}.body.results}}}}"}, "metadata": b.meta("審核紀錄轉成 JSON")}
    can_see = [[c(f1["own"], "text:equal", "yes")], [c(f1["mgr"], "text:equal", "yes")], [c(f1["rev_ok"], "text:equal", "yes")]]
    task_flow = [*pre_t, b.router("可否查看任務", [
        (flt("可以查看", can_see), [
            logs, tj, lj,
            respond("回傳任務明細", '{"ok":true,"id":"' + f"{{{{{G1}.id}}}}" + '","own":"' + f1["own"]
                    + '","canReview":"' + f1["rev_ok"] + '","reviewer":"' + f1["rev"] + '","role":"' + f1["role"]
                    + '","task":' + f"{{{{{tj['id']}.json}}}}" + ',"logs":' + f"{{{{{lj['id']}.json}}}}" + "}")]),
        (flt("不能查看", [[c(f1["own"], "text:equal", "no"), c(f1["mgr"], "text:equal", "no"), c(f1["rev_ok"], "text:equal", "no")]]), [
            forbidden("回傳沒有權限（任務明細）")]),
    ])]

    # ---- save：交件。只有負責這個職掌的人能改；可改狀態（不能自己核准）、雲端連結、留言、上傳一個檔案 ----
    # 時間（提交時間、實際交付日）與版本號都由系統寫入，頁面不送
    SAVE_STATUSES = ["尚未開始", "執行創作中", "待審核"]
    EXTS = ["jpg", "jpeg", "png", "gif", "webp", "heic", "pdf", "mp4", "mov", "mp3", "wav", "m4a", "zip",
            "psd", "ai", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt"]
    status_v = pick("1.status", SAVE_STATUSES, '"執行創作中"')
    # Make 沒有 startsWith，用 indexOf = 0 判斷開頭
    link_v = '{{if(indexOf(1.link; "https://") = 0; substring(1.link; 0; 500); "")}}'
    note_v = cut("1.note", 1000)
    submit = 'if(1.status = "待審核"; '
    pre_s, G2, f2 = read_task("交件")
    task_name = sp(G2, "任務名稱", "[].plain_text")
    # 版本號：同一個工作項目每次送審自動加一。
    #   第一次送審：沿用 Notion 上已有的版本（之前手動填過的），沒有就是 V1
    #   之後再送審（已有提交時間、目前不是待審核）：下一號；待審核時重存只改內容，不跳號
    #   「最終定案」或超過 V30 就不再變動；其他儲存（沒有送審）不改版本
    cur = inner(sp(G2, "版本號", ".name"))
    nxt = "switch(ifempty(" + cur + '; "V0"); ' + "; ".join(f'"V{i}"; "V{i + 1}"' for i in range(30)) + "; " + cur + ")"
    first = "ifempty(" + inner(sp(G2, "提交時間", ".start")) + '; "") = ""'
    on_submit = ("if(" + first + "; ifempty(" + cur + '; "V1"); if(' + inner(sp(G2, "狀態", ".name"))
                 + ' = "待審核"; ifempty(' + cur + '; "V1"); ' + nxt + "))")
    version_v = "{{" + submit + on_submit + "; " + cur + ")}}"

    def save_route(label, file_link):
        return [
            b.update(f"更新任務（{label}）", f"{{{{{G2}.id}}}}", [
                fv("狀態", "select", status_v), fv("版本號", "select", version_v), fv("交付雲端連結", "url", link_v),
                # 頁面的說明欄每次都是空的（寫這一次的說明）；沒寫就保留 Notion 上原本的留言
                fv("執行者留言", "rich_text", "{{ifempty(" + inner(note_v) + "; join(map(" + str(G2)
                   + '.properties_value.`執行者留言`; "plain_text"); ""))}}'),
                fv("提交人", "rich_text", "{{" + submit + inner(w_name) + '; "")}}'),
                now("提交時間", "{{" + submit + 'now; "")}}'),
                {"key": "實際交付日", "type": "date", "date": {"start": "{{" + submit + 'formatDate(now; "YYYY-MM-DD"); "")}}'}}],
                ds=DS_TASK),
            b.create(f"新增審核紀錄（{label}）", [
                fv("紀錄", "title", task_name + "｜{{" + submit + '"送審"; "改狀態")}}'),
                fv("任務", "relation", f'{{{{split({G2}.id; ",")}}}}'),
                fv("動作", "select", "{{" + submit + '"送審"; "改狀態")}}'), fv("狀態", "select", status_v),
                fv("版本號", "select", version_v), fv("身分", "select", f2["role"]), fv("姓名", "rich_text", w_name),
                now("時間"), fv("意見", "rich_text", note_v), fv("雲端連結", "url", link_v), fv("上傳檔案", "url", file_link)],
                ds=DS_REVIEW),
            respond(f"回傳已儲存（{label}）", '{"ok":true}'),
            # 專案開了即刻推播：狀態改了就推給全專案（先回應頁面，推播慢一點也不影響畫面）
            *progress_push(b, f2["p"], f"交件{label}", only_instant=True),
        ]
    up = b.drive_upload("交件檔案存到雲端硬碟", sp(G2, "序號") + "_{{formatDate(now; \"YYYYMMDD-HHmmss\")}}."
                        + pick("1.ext", EXTS, '"bin"'), "1.file")
    U = up["id"]
    attach = b.notion_api("檔案放進任務的交付檔案上傳", f"/v1/pages/{{{{{G2}.id}}}}", "PATCH", json.dumps({"properties": {
        "交付檔案上傳": {"files": [{"name": f"{{{{{U}.name}}}}", "type": "external",
                              "external": {"url": f"{{{{{U}.webViewLink}}}}"}}]}}}, ensure_ascii=False))
    can_edit = [c(f2["own"], "text:equal", "yes"), c(sp(G2, "狀態", ".name"), "text:notequal", "已核准")]
    save_flow = [*pre_s, b.router("可否交件", [
        (flt("交件（含檔案）", [can_edit + [c("{{1.file}}", "exist")]]), [up, attach, *save_route("含檔案", f"{{{{{U}.webViewLink}}}}")]),
        (flt("交件（不含檔案）", [can_edit + [c("{{1.file}}", "notexist")]]), save_route("不含檔案", "")),
        (flt("不能交件", [[c(f2["own"], "text:equal", "no")], [c(sp(G2, "狀態", ".name"), "text:equal", "已核准")]]), [
            respond("回傳不能交件", '{"ok":false,"error":"locked"}', "409")]),
    ])]

    # ---- review：審核待審核的任務。總監的工作由導演審核；導演、副製片、製片人的工作由製片人審核 ----
    pre_r, G3, f3 = read_task("審核")
    approved = 'if(1.decision = "approve"; '
    result = "{{" + approved + '"已核准"; "退回修改")}}'
    comment_v = cut("1.comment", 1000)
    task3 = sp(G3, "任務名稱", "[].plain_text")
    review_flow = [*pre_r, b.router("可否審核", [
        (flt("可以審核", [[c(sp(G3, "狀態", ".name"), "text:equal", "待審核"), c(f3["rev_ok"], "text:equal", "yes"),
                           c("{{1.decision}}", "text:equal", d)] for d in ("approve", "return")]), [
            b.update("寫入審核結果", f"{{{{{G3}.id}}}}", [
                fv("狀態", "select", result), fv("審核意見", "rich_text", comment_v), now("審核日期"),
                fv("審核身分", "select", f3["rev"]), fv("審核人", "rich_text", w_name)], ds=DS_TASK),
            b.create("新增審核紀錄（審核）", [
                fv("紀錄", "title", task3 + "｜{{" + approved + '"核准"; "退回")}}'),
                fv("任務", "relation", f'{{{{split({G3}.id; ",")}}}}'),
                fv("動作", "select", "{{" + approved + '"核准"; "退回")}}'), fv("狀態", "select", result),
                fv("版本號", "select", sp(G3, "版本號", ".name")), fv("身分", "select", f3["rev"]),
                fv("姓名", "rich_text", w_name), now("時間"), fv("意見", "rich_text", comment_v)], ds=DS_REVIEW),
            respond("回傳已審核", '{"ok":true}'),
            *progress_push(b, f3["p"], "審核", only_instant=True)]),
        (flt("不是待審核", [[c(sp(G3, "狀態", ".name"), "text:notequal", "待審核")]]), [
            respond("回傳不能審核", '{"ok":false,"error":"bad_target"}', "409")]),
        (flt("不是這項工作的審核者", [[c(sp(G3, "狀態", ".name"), "text:equal", "待審核"), c(f3["rev_ok"], "text:equal", "no")]]), [
            forbidden("回傳沒有權限（審核）")]),
    ])]

    act = lambda a: c("{{1.a}}", "text:equal", a)
    ACTS = ("me", "projects", "apply", "tasks", "links", "pending", "approve", "reject", "task", "save", "review",
            "push_get", "push_set", "push_now", "setup")
    PUSH_ACTS = ("push_get", "push_set", "push_now")
    MEMBER_ACTS = ("tasks", "links", "task", "save", "review")
    PRODUCER_ACTS = ("pending", "approve", "reject")
    with_id = c("{{1.id}}", "exist")
    flow = [
        webhook(MK["api_hook_id"], "LIFF 頁面送來的請求"),
        b.router("請求種類", [
            (flt("LIFF 請求", [[c("{{1.t}}", "exist"), act(a)] for a in ACTS]), [
                verify,
                b.router("身分驗證", [
                    (flt("不是本系統的憑證", [[c("{{2.data.client_id}}", "text:notequal", CHANNEL)]]), [
                        respond("回傳驗證失敗", '{"ok":false,"error":"auth"}', "401")]),
                    (flt("身分驗證成功", [[c("{{2.data.client_id}}", "text:equal", CHANNEL)]]), [profile, w, mine, ctx, b.router("依動作分流", [
                        (flt("我的身分", [[act("me")]]), me_flow),
                        (flt("專案清單", [[act("projects")]]), projects_flow),
                        (flt("申請加入", [[act("apply"), c("{{1.name}}", "exist"), c("{{1.project}}", "exist"),
                                          c(role_v, "exist")]]), apply_flow),
                        (flt("任務", [[act("tasks"), *is_member]]), tasks_flow),
                        (flt("雲端資料夾", [[act("links"), *is_member]]), links_flow),
                        (flt("讀推播設定", [[act("push_get"), *g] for g in can_push]), push_get_flow),
                        (flt("改推播設定", [[act("push_set"), *g] for g in can_push]), push_set_flow),
                        (flt("現在推一次", [[act("push_now"), *g] for g in can_push]), push_now_flow),
                        (flt("建立專案工作", [[act("setup"), c("{{1.pid}}", "exist"), c("{{" + ADM + "}}", "text:equal", "yes"), active]]),
                         setup_flow),
                        (flt("不是平台管理者（建立專案工作）", [[act("setup"), c("{{" + ADM + "}}", "text:notequal", "yes")],
                                                     [act("setup"), disabled]]), [forbidden("回傳沒有權限（建立專案工作）")]),
                        (flt("不是這個專案的製片人或導演", [[act(a)] + g for a in PUSH_ACTS for g in no_push]), [
                            forbidden("回傳沒有權限（推播）")]),
                        (flt("待核准名單", [[act("pending"), *is_producer]]), pending_flow),
                        (flt("核准", [[act("approve"), with_id, *is_producer]]), approve_flow),
                        (flt("退回", [[act("reject"), with_id, *is_producer]]), reject_flow),
                        (flt("任務明細", [[act("task"), with_id, *is_member]]), task_flow),
                        (flt("交件", [[act("save"), with_id, *is_member]]), save_flow),
                        (flt("審核任務", [[act("review"), with_id, *is_member]]), review_flow),
                        (flt("不是製片人", [[act(a)] + g for a in PRODUCER_ACTS for g in not_producer]), [
                            forbidden("回傳沒有權限（核准）")]),
                        (flt("不是團隊成員", [[act(a)] + g for a in MEMBER_ACTS for g in not_member]), [
                            forbidden("回傳沒有權限（任務）")]),
                    ])]),
                ])]),
            # 先檢查格式，不對就直接回 400，不先問 LINE，減少被亂打時消耗的額度
            (flt("格式不對", [[c("{{1.a}}", "notexist")], [c("{{1.t}}", "notexist")],
                              [c("{{1.a}}", "text:notequal", a) for a in ACTS]]), [
                respond("回傳格式不對", '{"ok":false,"error":"bad_request"}', "400")]),
        ]),
    ]
    return blueprint("LIFF API", flow)


# ==== 風雅存｜LINE 事件 ====
def build_events():
    """加好友（follow）就在名冊建一筆訪客；封鎖（unfollow）時標記。只處理每次送來的第一個事件。"""
    b = B()
    uid, typ = "{{1.events[1].source.userId}}", "{{1.events[1].type}}"
    w = b.search("找名冊", DS_MEMBER, [[c(prop("LINE User ID", "rich_text"), "text:equals", uid)]])
    w["filter"] = flt("只處理加好友、封鎖", [[c(typ, "text:equal", "follow")], [c(typ, "text:equal", "unfollow")]])
    W = w["id"]
    exist, none = c(f"{{{{{W}.id}}}}", "exist"), c(f"{{{{{W}.id}}}}", "notexist")
    prof = b.line("取得 LINE 名稱", f"/v2/bot/profile/{uid}")
    P = prof["id"]
    flow = [
        {"id": 1, "module": "line:watchMessages", "version": 1, "mapper": {},
         "metadata": {"designer": {"x": -300, "y": 0, "name": "LINE 事件"},
                      "parameters": [{"name": "__IMTHOOK__", "type": "hook:line", "label": "Webhook", "required": True}]},
         "parameters": {"__IMTHOOK__": MK["events_hook_id"]}},
        w,
        b.router("依事件分流", [
            (flt("新好友", [[c(typ, "text:equal", "follow"), none]]), [
                prof,
                b.create("新增訪客", [fv("姓名", "title", f"（LINE）{{{{{P}.body.displayName}}}}"), fv("狀態", "select", "訪客"),
                                  fv("好友狀態", "select", "好友中"), fv("LINE 顯示名稱", "rich_text", f"{{{{{P}.body.displayName}}}}"),
                                  fv("LINE User ID", "rich_text", uid), fv("目前選單", "select", "訪客"), now("加入好友時間")])]),
            # 封鎖時 LINE 會拿掉個人選單，解除封鎖後只剩預設的訪客選單；依名冊記的「目前選單」重新綁回去
            #（封鎖再解除封鎖後，選單會停在「加入團隊成員」）。舊值「製作人」視同製片人
            (flt("重新加好友", [[c(typ, "text:equal", "follow"), exist]]), [
                b.update("改回好友中", f"{{{{{W}.id}}}}", [fv("好友狀態", "select", "好友中")]),
                b.router("重新綁定選單", [
                    (flt(f"綁回{menu}選單", [[c(sp(W, "目前選單", ".name"), "text:equal", v)] for v in names]),
                     link_menu(b, uid, f"{{{{{W}.id}}}}", menu, "重新加好友"))
                    for menu, names in (("團隊成員", ["團隊成員"]), ("導演", ["導演"]), ("製片人", ["製片人", "製作人"]))])]),
            (flt("封鎖", [[c(typ, "text:equal", "unfollow"), exist]]), [
                b.update("標記已封鎖", f"{{{{{W}.id}}}}", [fv("好友狀態", "select", "已封鎖")])]),
        ]),
    ]
    return blueprint("LINE 事件", flow)


# ==== 風雅存｜建立圖文選單（手動執行） ====
def build_menu():
    """建立四張選單，訪客選單設為所有人的預設，其他三張設別名；清掉舊選單；已核准的成員重新綁到新選單。
    圖片從 GitHub Pages 下載（tools/make_richmenu.py 產生），LINE 規定寬 2500、1MB 以內。"""
    b = B(10)
    made = {}
    flow = []
    for menu, (alias, img, buttons) in MENUS.items():
        step = MENU_W // len(buttons)
        areas = [{"bounds": {"x": i * step, "y": 0, "width": MENU_W - i * step if i == len(buttons) - 1 else step,
                             "height": MENU_H},
                  "action": {"type": "uri", "uri": LIFF + q, "label": text}} for i, (q, text) in enumerate(buttons)]
        g = {"id": b.nid(), "module": "http:ActionGetFile", "version": 3, "parameters": {"handleErrors": False},
             "mapper": {"url": f"{PAGES}/assets/{img}", "method": "get", "serializeUrl": False, "shareCookies": False},
             "metadata": b.meta(f"下載{menu}選單圖片")}
        m = {"id": b.nid(), "module": "line:createARichMenu", "version": 1, "parameters": {"__IMTCONN__": CONN_LINE},
             "mapper": {"name": alias or "guest", "chatBarText": "選單", "selected": True, "height": MENU_H, "areas": areas,
                        "data": f"{{{{{g['id']}.data}}}}", "filename": img},
             "metadata": b.meta(f"建立{menu}選單", LINE_META)}
        made[menu] = m["id"]
        flow += [g, m]
    new_id = lambda menu: f"{{{{{made[menu]}.richMenuId}}}}"
    all_made = [c(new_id(m), "exist") for m in MENUS]

    # 預設選單一定要在全部建好之後才設：Make 的「Create a Rich Menu」勾了 selected 會把剛建好的那張設成預設
    #（line-namecard 2026-10-21 會員選單因此蓋過訪客選單）
    flow.append(b.line("設為所有人的預設選單（訪客）", f"/v2/bot/user/all/richmenu/{new_id('訪客')}", "POST"))
    for menu, (alias, *_r) in MENUS.items():
        if not alias:
            continue
        # 已有別名時更新成功、新建失敗；第一次部署時相反，各自出錯就略過
        flow.append(b.router(f"設定{menu}選單別名", [
            (flt("更新別名", [all_made]), [
                b.line(f"更新別名 {alias}", f"/v2/bot/richmenu/alias/{alias}", "POST", {"richMenuId": new_id(menu)}, onerror=[b.ignore()])]),
            (flt("新建別名", [all_made]), [
                b.line(f"新建別名 {alias}", "/v2/bot/richmenu/alias", "POST",
                       {"richMenuAliasId": alias, "richMenuId": new_id(menu)}, onerror=[b.ignore()])]),
        ]))

    lst = b.line("列出所有圖文選單", "/v2/bot/richmenu/list")
    feed = {"id": b.nid(), "module": "builtin:BasicFeeder", "version": 1, "mapper": {"array": f"{{{{{lst['id']}.body.richmenus}}}}"},
            "metadata": b.meta("逐張檢查")}
    F = feed["id"]
    delete = b.line("刪除舊選單", f"/v2/bot/richmenu/{{{{{F}.richMenuId}}}}", "DELETE", onerror=[b.ignore()])
    # 篩選一定要在放進 router 之前設定：router 會複製模組，之後才設的篩選不會進藍圖
    #（2026-10-22 第一次執行因此把剛建好的四張也刪掉了）
    delete["filter"] = flt("不是新的四張", [[c(f"{{{{{F}.richMenuId}}}}", "text:notequal", new_id(m)) for m in MENUS]])
    # 依名冊記的「目前選單」重新綁定（角色依專案設定，選單是取最高角色算出來後記在名冊；舊值「製作人」視同製片人）
    members = b.search("找有個人選單的成員", DS_MEMBER, [[c(prop("目前選單", "select"), "select:equals", m)]
                                                  for m in ("團隊成員", "導演", "製片人", "製作人")], limit="200")
    MB = members["id"]
    mb_uid, mb_menu, mb_page = sp(MB, "LINE User ID", "[].plain_text"), sp(MB, "目前選單", ".name"), f"{{{{{MB}.id}}}}"

    def rebind(menu, names):
        return (flt(f"{menu}選單", [[c(mb_menu, "text:equal", n), c(mb_uid, "exist")] for n in names]), [
            b.line(f"綁定新的{menu}選單", f"/v2/bot/user/{mb_uid}/richmenu/{new_id(menu)}", "POST", onerror=[b.ignore()]),
            b.update(f"記下目前選單：{menu}（重建）", mb_page, [fv("目前選單", "select", menu), now("選單同步時間")])])
    flow.append(b.router("收尾", [
        # 刪除舊選單時，LINE 會自動解除所有人身上的舊綁定，所以接著重新綁定
        (flt("清掉舊選單", [all_made]), [lst, feed, delete]),
        (flt("成員重新綁定", [all_made]), [members, b.router("依目前選單綁定", [
            rebind("團隊成員", ["團隊成員"]), rebind("導演", ["導演"]), rebind("製片人", ["製片人", "製作人"])])]),
    ]))
    return blueprint("建立圖文選單（手動執行）", flow, instant=False)


# ==== 風雅存｜進度推播（每小時） ====
def build_hourly():
    """每小時跑一次：找出開了每日推播、推播時間＝現在台灣時間整點的專案，逐一推播。其他時候讀完設定就結束。"""
    b = B(10)
    due = b.notion_api("找這個整點要推播的專案", f"/v1/databases/{DB_PUSH}/query", "POST", raw_json(
        {"filter": {"and": [{"property": "每日推播", "checkbox": {"equals": True}},
                            {"property": "推播時間", "number": {"equals": "__h__"}}]}, "page_size": 50},
        {"h": '{{parseNumber(formatDate(now; "H"; "Asia/Taipei"))}}'}))
    feed = {"id": b.nid(), "module": "builtin:BasicFeeder", "version": 1,
            "mapper": {"array": f"{{{{{due['id']}.body.results}}}}"}, "metadata": b.meta("逐一處理專案")}
    F = feed["id"]
    # 專案 id 先放進變數：運算式裡的引號放進 JSON 查詢條件會被跳脫，Make 就讀不懂
    pv = b.setvars("這個專案", {"p": "{{first(map(" + f"{F}.properties.`專案`.relation" + '; "id"))}}'})
    return blueprint("進度推播（每小時）", [due, feed, pv, *progress_push(b, f"{{{{{pv['id']}.p}}}}", "每日")], instant=False)


def main():
    out = ROOT / "make" / ("example" if EXAMPLE else "")
    out.mkdir(parents=True, exist_ok=True)
    for fname, bp in (("LIFF_API.blueprint.json", build_api()), ("LINE事件.blueprint.json", build_events()),
                      ("建立圖文選單.blueprint.json", build_menu()), ("進度推播.blueprint.json", build_hourly())):
        p = out / fname
        p.write_text(json.dumps(bp, ensure_ascii=False, indent=1), encoding="utf-8")
        print(p.relative_to(ROOT), p.stat().st_size)


if __name__ == "__main__":
    main()

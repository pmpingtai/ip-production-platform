"""產生風雅存 LINE 官方帳號的三個 Make 情境藍圖，輸出到 make/（範例設定輸出到 make/example/）：

- LIFF_API.blueprint.json：「風雅存｜LIFF API」
    LIFF 頁面用表單格式送到同一個 webhook，欄位 a 是動作、t 是 LIFF Access Token：
    me 我的身分（順便校正選單）｜apply 申請加入｜tasks 任務與專案｜pending 待核准名單｜approve 核准｜reject 退回
- LINE事件.blueprint.json：「風雅存｜LINE 事件」加好友就在名冊建一筆訪客；封鎖時標記
- 建立圖文選單.blueprint.json：「風雅存｜建立圖文選單（手動執行）」建四張選單、訪客選單設為預設、
    其他三張設別名（member、producer、director），清掉舊選單後把已核准的成員重新綁定

身分與選單：
    訪客、審核中、已退回、停用 → 訪客選單（預設，不綁個人）
    已核准：編劇、藝術總監、作畫監督、聲音總監 → 團隊成員選單（member）
    已核准：製作人 → 製作人選單（producer）；導演 → 導演選單（director）。兩張目前內容相同，之後可以分開調整。

做法沿用苗栗收容所系統與 line-namecard 的會員模組。
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
CONN_NOTION, CONN_LINE = MK["notion_connection_id"], MK["line_connection_id"]
CHANNEL = LN["login_channel_id"]
LIFF = f"https://liff.line.me/{LN['liff_id']}"
DS_MEMBER, DS_TASK, DS_PROJECT = NT["members_ds"], NT["tasks_ds"], NT["projects_ds"]
PAGES = CFG["pages_base"].rstrip("/")
ORIGIN = CFG.get("page_origin") or "*"
PREFIX = f"{CFG['project']}｜" if CFG.get("project") else ""

CREATORS, MANAGERS, APPROVERS = ROLES_CFG["creators"], ROLES_CFG["managers"], ROLES_CFG["approvers"]
ROLES = CREATORS + MANAGERS
ALIASES = ROLES_CFG["aliases"]

# 選單（Notion「目前選單」的選項）→ LINE 選單別名、圖片檔名、按鈕（相對 LIFF 網址的參數、說明）
MENUS = {
    "訪客": (None, "richmenu_guest.png", [("?v=join", "加入團隊成員")]),
    "團隊成員": ("member", "richmenu_member.png", [("?v=work", "我的工作"), ("?v=progress", "我的進度")]),
    "製作人": ("producer", "richmenu_producer.png", [("?v=approve", "核准團隊成員"), ("?v=team", "團隊進度")]),
    "導演": ("director", "richmenu_director.png", [("?v=approve", "核准團隊成員"), ("?v=team", "團隊進度")]),
}
MENU_W, MENU_H = 2500, 843   # 單列選單；和 tools/make_richmenu.py 一致

# HTTP「Make a request」模組的必填設定。用 API 建立時不會自動帶入，少了會報 BundleValidationError（苗栗踩過）
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


def now(k):
    return {"key": k, "type": "date", "date": {"start": "{{now}}", "includeTime": True}}


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

    def create(self, name, fields):
        return self.notion("createDataSourceItem", name, {"fields": fields, "select": "map", "data_source": DS_MEMBER})

    def update(self, name, page, fields):
        return self.notion("updateADatabaseItem", name,
                           {"page": page, "fields": fields, "select": "map", "updateBy": "data_source", "data_source": DS_MEMBER})

    def line(self, name, url, method="GET", body=None, onerror=None):
        mapper = {"url": url, "method": method, "headers": []}
        if body is not None:
            mapper["body"] = json.dumps(body, ensure_ascii=False)
            mapper["headers"] = [{"key": "Content-Type", "value": "application/json"}]
        d = {"id": self.nid(), "module": "line:makeApiCall", "version": 1, "parameters": {"__IMTCONN__": CONN_LINE},
             "mapper": mapper, "metadata": self.meta(name, LINE_META)}
        if onerror:
            d["onerror"] = onerror
        return d

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

    def to_json(self, name, feeder, fields):
        agg = {"id": self.nid(), "module": "builtin:BasicAggregator", "version": 1, "parameters": {"feeder": feeder},
               "mapper": {k: f"{{{{{feeder}.{k}}}}}" for k in fields}, "metadata": self.meta(f"彙整{name}")}
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
def expected_menu(state, role):
    """依名冊的狀態與角色，算出應該綁定哪一張選單（Notion「目前選單」的選項）"""
    return ('{{if(' + inner(state) + ' = "已核准"; switch(' + inner(role) + '; "製作人"; "製作人"; "導演"; "導演"; "團隊成員"); "訪客")}}')


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

    w = b.search("找我的名冊", DS_MEMBER, [[c(prop("LINE User ID", "rich_text"), "text:equals", UID)]])
    W = w["id"]
    w_page, w_state, w_role = f"{{{{{W}.id}}}}", sp(W, "狀態", ".name"), sp(W, "角色", ".name")
    w_menu, w_name = sp(W, "目前選單", ".name"), sp(W, "姓名", "[].plain_text")
    exist, none = c(w_page, "exist"), c(w_page, "notexist")
    is_member = c(w_state, "text:equal", "已核准")
    is_approver = [[exist, is_member, c(w_role, "text:equal", r)] for r in APPROVERS]
    forbidden = lambda name: respond(name, '{"ok":false,"error":"forbidden"}', "403")

    def body(state, name, apply_role, note, role=""):
        return ('{"ok":true,"state":"' + state + '","role":"' + role + '","applyRole":"' + apply_role
                + '","name":"' + enc(name) + '","note":"' + enc(note) + '","line":"' + enc(DISPLAY) + '"}')
    state_code = ('{{switch(' + inner(w_state) + '; "審核中"; "pending"; "已核准"; "member"; "已退回"; "rejected"; '
                  '"停用"; "disabled"; "guest")}}')
    me_body = body(state_code, w_name, sp(W, "申請角色", ".name"), sp(W, "備註", "[].plain_text"), w_role)
    guest_body = '{"ok":true,"state":"guest","role":"","applyRole":"","name":"","note":"","line":"' + enc(DISPLAY) + '"}'

    # ---- me：我的身分。先回應頁面再校正選單，換選單出錯也不會讓頁面卡住 ----
    expect = expected_menu(w_state, w_role)
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
    for menu in ("團隊成員", "製作人", "導演"):
        me_routes.append((flt(f"應該是{menu}選單", [[exist, c(expect, "text:equal", menu), c(w_menu, "text:notequal", menu)]]), [
            respond(f"回傳我的身分（校正成{menu}選單）", me_body), *link_menu(b, UID, w_page, menu, "校正")]))
    me_flow = [b.router("我的身分（順便校正選單）", me_routes)]

    # ---- apply：申請加入。申請者可改姓名、角色、說明；送出後通知製作人與導演 ----
    apply_fields = [fv("姓名", "title", cut("1.name", 40)), fv("申請角色", "select", pick("1.role", ROLES, "null")),
                    fv("備註", "rich_text", cut("1.note", 300)), fv("狀態", "select", "審核中"), now("申請時間"),
                    fv("LINE 顯示名稱", "rich_text", DISPLAY)]
    pending_body = body("pending", "{{1.name}}", pick("1.role", ROLES, '""'), "{{1.note}}")

    def notify():
        # 回應之後才通知；訊息不放申請者填的文字，避免被插入內容
        approvers = b.search("找製作人與導演（通知申請）", DS_MEMBER,
                             [[c(prop("狀態", "select"), "select:equals", "已核准"), c(prop("角色", "select"), "select:equals", r)]
                              for r in APPROVERS], limit="10")
        return [approvers, push(b, "推播新申請給製作人與導演", sp(approvers["id"], "LINE User ID", "[].plain_text"),
                                "📥 有新的團隊成員申請（申請角色：" + pick("1.role", ROLES, '"未填"')
                                + "），請到「核准團隊成員」處理：\n" + LIFF + "?v=approve")]
    can_apply = [[exist, c(w_state, "text:equal", s)] for s in ("訪客", "審核中", "已退回")]
    apply_flow = [b.router("申請加入", [
        (flt("新申請（還沒有名冊）", [[none]]), [
            b.create("新增名冊（審核中）", apply_fields + [fv("LINE User ID", "rich_text", UID), fv("好友狀態", "select", "好友中"),
                                                    fv("目前選單", "select", "訪客")]),
            respond("回傳審核中（新）", pending_body), *notify()]),
        (flt("訪客、審核中或已退回：更新申請", can_apply), [
            b.update("更新申請資料（審核中）", w_page, apply_fields), respond("回傳審核中", pending_body), *notify()]),
        (flt("已核准或停用", [[exist, c(w_state, "text:equal", "已核准")], [exist, c(w_state, "text:equal", "停用")]]), [
            respond("回傳目前身分（申請）", me_body)]),
    ])]

    # ---- tasks：任務與進行中的專案。總監只拿到自己的任務，導演與製作人拿到全部 ----
    not_template = c(prop("範本任務", "checkbox"), "checkbox:equals", "false")

    def tasks_branch(label, groups):
        tasks = b.search(f"找任務（{label}）", DS_TASK, groups, limit="500")
        t_mods, t_json = b.to_json(f"任務（{label}）", tasks["id"], ["id", "properties_value"])
        projects = b.search(f"找進行中的專案（{label}）", DS_PROJECT,
                            [[c(prop("專案狀態", "select"), "select:equals", "進行中")]], limit="50")
        p_mods, p_json = b.to_json(f"專案（{label}）", projects["id"], ["id", "properties_value"])
        return [tasks, *t_mods, projects, *p_mods,
                respond(f"回傳任務（{label}）", '{"ok":true,"tasks":' + t_json + ',"projects":' + p_json + "}")]
    # 執行職掌的條件依角色決定：不屬於這個角色的對應值換成不存在的選項，查不到任何任務
    creator_groups = [[not_template, c(prop("執行職掌", "select"), "select:equals",
                                       '{{if(' + inner(w_role) + f' = "{role}"; "{alias}"; "－")}}')]
                      for role in CREATORS for alias in ALIASES[role]]
    tasks_flow = [b.router("依角色查任務", [
        (flt("導演與製作人：全部任務", [[exist, is_member, c(w_role, "text:equal", r)] for r in MANAGERS]),
         tasks_branch("全部", [[not_template]])),
        (flt("總監：自己的任務", [[exist, is_member, c(w_role, "text:equal", r)] for r in CREATORS]),
         tasks_branch("自己的", creator_groups)),
        (flt("不是團隊成員（任務）", [[none], [exist, c(w_state, "text:notequal", "已核准")]]), [forbidden("回傳沒有權限（任務）")]),
    ])]

    # ---- pending：待核准名單（只有製作人與導演） ----
    waiting = b.search("找審核中的申請", DS_MEMBER, [[c(prop("狀態", "select"), "select:equals", "審核中")]], limit="50")
    w_mods, w_json = b.to_json("申請", waiting["id"], ["id", "properties_value"])
    pending_flow = [waiting, *w_mods, respond("回傳待核准名單", '{"ok":true,"members":' + w_json + "}")]

    # ---- approve／reject：只能處理「審核中」且有 LINE 帳號的申請 ----
    def target(label):
        t = b.get(f"讀申請（{label}）", "{{1.id}}",
                  onerror=[respond(f"回傳找不到申請（{label}）", '{"ok":false,"error":"bad_target"}', "409"), b.ignore()])
        T = t["id"]
        ok = [c(sp(T, "狀態", ".name"), "text:equal", "審核中"), c(sp(T, "LINE User ID", "[].plain_text"), "exist")]
        bad = [[c(sp(T, "狀態", ".name"), "text:notequal", "審核中")], [c(sp(T, "LINE User ID", "[].plain_text"), "notexist")]]
        return t, T, ok, bad

    t1, T1, ok1, bad1 = target("核准")
    T1_uid, T1_page = sp(T1, "LINE User ID", "[].plain_text"), f"{{{{{T1}.id}}}}"
    role = pick("1.role", ROLES, sp(T1, "申請角色", ".name")[2:-2])
    approve_route = [
        b.update("核准：設定角色", T1_page, [fv("狀態", "select", "已核准"), fv("角色", "select", role), now("核准時間"),
                                       fv("核准人", "rich_text", w_name)]),
        respond("回傳已核准", '{"ok":true}'),
        push(b, "通知申請者已核准", T1_uid, "✅ 你已加入風雅存製作團隊（角色：" + role + "）。\n下方選單會換成團隊版，點選單就能查看工作與進度。"),
        # Router 一定是路線的最後一個模組，所以推播放在換選單之前
        b.router("依角色換選單", [
            (flt("團隊成員選單", [[c(role, "text:equal", r)] for r in CREATORS]), link_menu(b, T1_uid, T1_page, "團隊成員", "核准")),
            (flt("製作人選單", [[c(role, "text:equal", "製作人")]]), link_menu(b, T1_uid, T1_page, "製作人", "核准")),
            (flt("導演選單", [[c(role, "text:equal", "導演")]]), link_menu(b, T1_uid, T1_page, "導演", "核准")),
        ]),
    ]
    approve_flow = [t1, b.router("可否核准", [
        (flt("可以核准", [ok1]), approve_route),
        (flt("不能核准", bad1), [respond("回傳不能核准", '{"ok":false,"error":"bad_target"}', "409")]),
    ])]

    t2, T2, ok2, bad2 = target("退回")
    reject_flow = [t2, b.router("可否退回", [
        (flt("可以退回", [ok2]), [
            b.update("退回申請", f"{{{{{T2}.id}}}}", [fv("狀態", "select", "已退回"), fv("核准人", "rich_text", w_name)]),
            respond("回傳已退回", '{"ok":true}'),
            push(b, "通知申請者未通過", sp(T2, "LINE User ID", "[].plain_text"),
                 "你的團隊成員申請沒有通過。如有疑問請洽製作人，也可以修改資料後重新申請：\n" + LIFF + "?v=join")]),
        (flt("不能退回", bad2), [respond("回傳不能退回", '{"ok":false,"error":"bad_target"}', "409")]),
    ])]

    act = lambda a: c("{{1.a}}", "text:equal", a)
    ACTS = ("me", "apply", "tasks", "pending", "approve", "reject")
    approver_only = lambda a: [g + [act(a)] for g in is_approver]
    not_approver = lambda a: [[act(a), none], [act(a), c(w_state, "text:notequal", "已核准")]] + \
        [[act(a), exist, is_member] + [c(w_role, "text:notequal", r) for r in APPROVERS]]
    flow = [
        webhook(MK["api_hook_id"], "LIFF 頁面送來的請求"),
        b.router("請求種類", [
            (flt("LIFF 請求", [[c("{{1.t}}", "exist"), act(a)] for a in ACTS]), [
                verify,
                b.router("身分驗證", [
                    (flt("不是本系統的憑證", [[c("{{2.data.client_id}}", "text:notequal", CHANNEL)]]), [
                        respond("回傳驗證失敗", '{"ok":false,"error":"auth"}', "401")]),
                    (flt("身分驗證成功", [[c("{{2.data.client_id}}", "text:equal", CHANNEL)]]), [profile, w, b.router("依動作分流", [
                        (flt("我的身分", [[act("me")]]), me_flow),
                        (flt("申請加入", [[act("apply"), c("{{1.name}}", "exist")]]), apply_flow),
                        (flt("任務", [[act("tasks")]]), tasks_flow),
                        (flt("待核准名單", approver_only("pending")), pending_flow),
                        (flt("核准", [g + [c("{{1.id}}", "exist")] for g in approver_only("approve")]), approve_flow),
                        (flt("退回", [g + [c("{{1.id}}", "exist")] for g in approver_only("reject")]), reject_flow),
                        (flt("不是製作人或導演", not_approver("pending") + not_approver("approve") + not_approver("reject")), [
                            forbidden("回傳沒有權限（核准）")]),
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
            (flt("重新加好友", [[c(typ, "text:equal", "follow"), exist]]), [
                b.update("改回好友中", f"{{{{{W}.id}}}}", [fv("好友狀態", "select", "好友中")])]),
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
    members = b.search("找所有已核准的成員", DS_MEMBER, [[c(prop("狀態", "select"), "select:equals", "已核准")]], limit="200")
    MB = members["id"]
    mb_uid, mb_role, mb_page = sp(MB, "LINE User ID", "[].plain_text"), sp(MB, "角色", ".name"), f"{{{{{MB}.id}}}}"

    def rebind(menu, roles):
        return (flt(f"{menu}選單", [[c(mb_role, "text:equal", r), c(mb_uid, "exist")] for r in roles]), [
            b.line(f"綁定新的{menu}選單", f"/v2/bot/user/{mb_uid}/richmenu/{new_id(menu)}", "POST", onerror=[b.ignore()]),
            b.update(f"記下目前選單：{menu}（重建）", mb_page, [fv("目前選單", "select", menu), now("選單同步時間")])])
    flow.append(b.router("收尾", [
        # 刪除舊選單時，LINE 會自動解除所有人身上的舊綁定（苗栗 10/14 舊選單卡住的教訓），所以接著重新綁定
        (flt("清掉舊選單", [all_made]), [lst, feed, delete]),
        (flt("已核准成員重新綁定", [all_made]), [members, b.router("依角色綁定", [
            rebind("團隊成員", CREATORS), rebind("製作人", ["製作人"]), rebind("導演", ["導演"])])]),
    ]))
    return blueprint("建立圖文選單（手動執行）", flow, instant=False)


def main():
    out = ROOT / "make" / ("example" if EXAMPLE else "")
    out.mkdir(parents=True, exist_ok=True)
    for fname, bp in (("LIFF_API.blueprint.json", build_api()), ("LINE事件.blueprint.json", build_events()),
                      ("建立圖文選單.blueprint.json", build_menu())):
        p = out / fname
        p.write_text(json.dumps(bp, ensure_ascii=False, indent=1), encoding="utf-8")
        print(p.relative_to(ROOT), p.stat().st_size)


if __name__ == "__main__":
    main()

import { buildMine, buildTeam, filterLabel, filterTasks, makeRoleMap, normalizeProject, normalizeTask } from './stats.js';

// ===== 設定：LIFF ID 與 API 網址。正式網址（GitHub Pages）一律用真資料；本機預覽才載入 mock.js =====
// 所有畫面都送到 Make 情境「風雅存｜LIFF API」，欄位 a 是動作：
//   me 我的身分與各專案角色（順便校正選單）｜projects 可申請的專案｜apply 申請加入某專案的某角色
//   tasks 任務與專案｜links 專案雲端資料夾｜pending 待核准名單｜approve 核准｜reject 退回
//   push_get／push_set／push_now 專案進度推播的設定與試推（該專案的製片人、導演）
//   task 任務明細與審核紀錄｜save 交件（改狀態、連結、留言、上傳檔案）｜review 審核任務（核准或退回）
// 角色依專案設定（Notion 帳號管理的「🧩 專案角色」）：一人可以在多個專案兼多個角色
const CONFIG = {
  liffId: '2012148035-ayugMk2W',
  apiUrl: 'https://hook.us2.make.com/6sasec528b8qabquet4dfc49my9opq2y',
};
const IN_LIFF_HOST = location.hostname.endsWith('github.io');

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const STATUS_VAR = { 尚未開始: '--s-todo', 執行創作中: '--s-doing', 待審核: '--s-review', 退回修改: '--s-returned', 已核准: '--s-done' };
const BAR_ORDER = ['已核准', '待審核', '執行創作中', '退回修改', '尚未開始'];
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

// ===== 後端：表單格式送出（瀏覽器不會先送 CORS 預檢） =====
class ApiError extends Error { constructor(code) { super(code); this.code = code; } }
// 後端手組的 JSON 會把自由文字 URL 編碼（Make 沒有 JSON 跳脫函式），這裡解碼
const ENC_KEYS = new Set(['name', 'line', 'note']);
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
async function post(fields) {
  const token = liff.getAccessToken();
  if (!token) throw new ApiError('no_token');
  const res = await fetch(CONFIG.apiUrl, { method: 'POST', body: new URLSearchParams({ ...fields, t: token }) });
  let data;
  try { data = await res.json(); } catch { throw new ApiError('server'); }
  if (!data.ok) throw new ApiError(data.error || 'server');
  for (const k of Object.keys(data)) if (ENC_KEYS.has(k) && typeof data[k] === 'string') data[k] = safeDecode(data[k]);
  return data;
}
let api = {
  me: () => post({ a: 'me' }),
  projects: () => post({ a: 'projects' }),
  apply: (f) => post({ a: 'apply', ...f }),
  tasks: () => post({ a: 'tasks' }),
  links: () => post({ a: 'links' }),
  push_get: (pid) => post({ a: 'push_get', pid }),
  push_set: (f) => post({ a: 'push_set', ...f }),
  push_now: (pid) => post({ a: 'push_now', pid }),
  setup: (pid, pname) => post({ a: 'setup', pid, pname }),
  pending: () => post({ a: 'pending' }),
  approve: (id, role) => post({ a: 'approve', id, role }),
  reject: (id) => post({ a: 'reject', id }),
  task: (id) => post({ a: 'task', id }),
  save: (f) => post({ a: 'save', ...f }),
  review: (id, decision, comment) => post({ a: 'review', id, decision, comment }),
};

// ===== 狀態 =====
const params = new URLSearchParams(location.search);
const VIEWS = ['join', 'work', 'approve', 'team', 'task', 'cloud'];
// 我的進度已併入我的工作（2026-11-02）；舊的 ?v=progress 連結一樣打開我的工作
const askedView = params.get('v') === 'progress' ? 'work' : params.get('v');
const S = {
  view: VIEWS.includes(askedView) ? askedView : null,
  roles: null, roleOf: null,
  me: null, tasks: null, projects: null, projectId: null, group: '全部',
  // 從進度頁點數字帶過來的篩選（見 stats.js 的 filterTasks）
  filter: params.get('f') || null,
  pending: null, applyProjects: null, links: null, form: { name: '', project: '', role: '', note: '' }, busy: false,
  // 任務明細：id、從哪個畫面點進來（返回用）、讀回的資料、上傳中的檔案
  detail: { id: params.get('id'), from: null, data: null, file: null },
};
// ===== 我在各專案的角色 =====
// me 回傳 keys：「|已核准:專案:角色|審核中:專案:角色|」（Notion 公式「權限碼」串起來的），拆成清單使用
const plainId = (id) => String(id || '').replaceAll('-', '');
const parseKeys = (keys) => String(keys || '').split('|').filter(Boolean).map((k) => {
  const [status, pid, role] = k.split(':');
  return { status, pid: plainId(pid), role };
}).filter((a) => a.pid && a.role);
const approved = () => (S.me?.assign || []).filter((a) => a.status === '已核准');
const rolesIn = (pid) => approved().filter((a) => a.pid === plainId(pid)).map((a) => a.role);
const hasRole = (role) => approved().some((a) => a.role === role);
const isMember = () => S.me?.state === 'member';
// 平台管理者（Notion 名冊勾選）：核准所有專案的所有申請（含製片人），看得到所有專案
const isAdmin = () => S.me?.admin === 'yes';
const managesIn = (pid) => isAdmin() || rolesIn(pid).some((r) => S.roles.managers.includes(r));
// 製片人、副製片、導演（任一專案）看得到團隊進度；製片人核准自己專案的成員（製片人除外）
const isManager = () => isMember() && (isAdmin() || approved().some((a) => S.roles.managers.includes(a.role)));
const isApprover = () => isMember() && (isAdmin() || hasRole('製片人'));
const ROLE_RANK = ['製片人', '導演', '副製片', '編劇', '藝術總監', '動畫總監', '聲音總監'];
const topRole = () => (isAdmin() ? '平台管理者' : ROLE_RANK.find(hasRole) || '');
// 七個角色都能申請（2026-11-02 起）；製片人的申請只有平台管理者能核准
const APPLY_ROLES = () => [...S.roles.managers, ...S.roles.creators];

// ===== 共用元件 =====
function fmtDate(d) {
  if (!d) return '未排日期';
  const [, m, day] = d.split('-').map(Number);
  return `${m}/${day}（${WEEKDAY[new Date(`${d}T00:00:00Z`).getUTCDay()]}）`;
}
function statusBar(counts, total, slim = false) {
  const cls = `bar-s${slim ? ' slim' : ''}`;
  if (!total) return `<div class="${cls}"></div>`;
  const parts = BAR_ORDER.filter((s) => counts[s] > 0)
    .map((s) => `<span style="width:${(counts[s] / total) * 100}%;background:var(${STATUS_VAR[s]})"></span>`).join('');
  return `<div class="${cls}" role="img" aria-label="${BAR_ORDER.map((s) => `${s} ${counts[s]}`).join('、')}">${parts}</div>`;
}
// 數字都可以點：帶 data-filter，點了列出那些工作（0 的不能點）
const pick = (key, n, inner, cls = '') =>
  (n ? `<button class="${cls} pickable" data-filter="${esc(key)}">${inner}</button>` : `<span class="${cls}">${inner}</span>`);
const legend = (counts) => `<div class="legend">${BAR_ORDER.map((s) =>
  pick(`status:${s}`, counts[s], `<i style="background:var(${STATUS_VAR[s]})"></i>${s} ${counts[s]}`)).join('')}</div>`;
const tiles = (items, cls = '') => `<div class="tiles ${cls}">${items.map(([label, n, tone, key]) =>
  pick(key, n, `<b>${n}</b><span>${label}</span>`, `tile ${n ? tone || '' : 'zero'}`)).join('')}</div>`;

// 「全部專案」時每項工作前面標出專案名稱
const projectName = (pid) => (S.projects || []).find((p) => p.id === pid)?.name.replace(/^【(.+?)】.*$/, '$1') || '';
function taskList(tasks, { showRole = false, today } = {}) {
  if (!tasks.length) return '<p class="empty">沒有項目</p>';
  const showProject = S.projectId === 'all';
  return `<ul class="tasks">${tasks.map((t) => {
    const late = t.due && t.due < today && t.status !== '已核准';
    const meta = [showProject ? projectName(t.projectId) : null, showRole ? t.role : null, t.workflow || t.stage, t.version]
      .filter(Boolean).join(' · ');
    return `<li data-task="${esc(t.id)}" tabindex="0"><span class="t-name">${esc(t.name)}</span><span class="t-meta">${esc(meta)}</span>
      <span class="t-side"><span class="chip" data-s="${esc(t.status)}">${esc(t.status)}</span><br>
      <small class="${late ? 'due-late' : 'muted'}">${fmtDate(t.due)}</small></span></li>`;
  }).join('')}</ul>`;
}
const listCard = (title, tasks, opts) =>
  `<section class="card"><h2>${title}<span class="count">${tasks.length}</span></h2>${taskList(tasks, opts)}</section>`;
const progressCard = (title, s) => `<section class="card"><h2>${title}</h2>
  <div class="hero"><span class="pct">${s.percent}%</span>${pick('status:已核准', s.done, `已核准 ${s.done} / 共 ${s.total} 項`, 'sub')}</div>
  ${statusBar(s.counts, s.total)}${legend(s.counts)}</section>`;
const stageRows = (stages) => `<div class="rows">${stages.map((g) => `<button class="stage pickable" data-filter="${esc(`stage:${g.stage}`)}">
  <div class="row-head"><span class="r-name">${esc(g.stage)} ›</span>
  <span class="r-nums">${g.done}/${g.total}${g.overdue ? ` · <span class="alert">逾期 ${g.overdue}</span>` : ''}</span></div>
  ${statusBar(g.counts, g.total, true)}</button>`).join('')}</div>`;
// 篩選後的清單：上方標出條件，可以一鍵回到全部
function filteredView(v, { showRole = false } = {}) {
  const list = filterTasks(v.tasks, S.filter, v.today);
  return [`<section class="card filter-bar"><span>篩選：<b>${esc(filterLabel(S.filter))}</b>・${list.length} 項</span>
      <button class="ghost" data-filter="">顯示全部 ✕</button></section>`,
    list.length ? `<section class="card">${taskList(list, { today: v.today, showRole })}</section>` : '<p class="empty center">沒有符合的工作</p>'];
}

function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.append(t); setTimeout(() => t.remove(), 2400);
}

// ===== 畫面 =====
const TITLES = {
  join: '加入團隊成員', work: '我的工作', progress: '我的進度', approve: '核准團隊成員', team: '團隊進度', task: '工作項目',
  cloud: '雲端資料夾',
};

function render() {
  $('#title').textContent = TITLES[S.view] || '風雅存製作團隊';
  document.title = `${TITLES[S.view] || '風雅存'}｜風雅存製作團隊`;
  const badge = $('#badge');
  const st = S.me?.state;
  badge.hidden = !S.me || st === 'guest';
  badge.className = `badge ${st === 'pending' ? 'pending' : st === 'member' ? '' : 'muted'}`;
  badge.textContent = st === 'member' ? topRole() : st === 'pending' ? '審核中' : st === 'rejected' ? '未通過' : st === 'disabled' ? '停用' : '';
  $('#navBack').hidden = !canGoBack();
  $('#bar').hidden = true;
  $('#tabs').hidden = true;
  $('#ptabs').hidden = true;
  $('#project').hidden = true;
  $('#foot').textContent = '';

  if (!S.me) { $('#app').innerHTML = '<p class="blocked">讀取中…</p>'; return; }
  if (st === 'disabled') return blocked('帳號已停用', '如有疑問請洽製片人。');
  if (S.view === 'join' || !isMember()) return renderJoin();
  if (S.view === 'approve') return isApprover() ? renderApprove() : blocked('沒有權限', '只有製片人可以核准團隊成員。');
  if (S.view === 'team' && !isManager()) return blocked('沒有權限', '團隊進度只開放給製片人、副製片與導演。');
  if (S.view === 'task') return renderTask();
  if (S.view === 'cloud') return renderCloud();
  if (!S.tasks) { $('#app').innerHTML = '<p class="blocked">讀取任務中…</p>'; return; }
  renderProjectSelect();
  if (!S.projectId) return blocked('目前沒有專案', S.view === 'team' ? '你還沒有擔任任何專案的製片人、副製片或導演。' : '你參與的專案目前沒有任務。');
  if (S.view === 'team') return renderTeam();
  return renderWork();
}

function blocked(title, text) {
  $('#app').innerHTML = `<div class="blocked"><h2>${esc(title)}</h2><p>${esc(text)}</p></div>`;
}

// 團隊進度只列我管理的專案（製片人、副製片、導演；平台管理者全部）；我的工作列我有角色的專案
const visibleProjects = () => (S.projects || []).filter((p) => (S.view === 'team' ? managesIn(p.id) : rolesIn(p.id).length));
// 專案標籤：參與兩個以上專案時出現「全部專案」＋各專案，「全部專案」看總工作量，其他看個別專案
function renderProjectSelect() {
  const list = visibleProjects();
  const ids = [...(list.length > 1 ? ['all'] : []), ...list.map((p) => p.id)];
  if (!ids.includes(S.projectId)) S.projectId = ids[0] ?? null;
  const nav = $('#ptabs');
  nav.innerHTML = list.length > 1 ? ids.map((id) => `<button data-project="${esc(id)}" aria-pressed="${id === S.projectId}">${
    esc(id === 'all' ? '全部專案' : projectName(id) || '專案')}</button>`).join('') : '';
  nav.hidden = list.length < 2;
}
const scopeIds = () => (S.projectId === 'all' ? visibleProjects().map((p) => p.id) : [S.projectId]);
const roleText = (pid) => rolesIn(pid).join('、');

// ---- 加入團隊成員 ----
const STATUS_CHIP = { 已核准: '已核准', 審核中: '待審核', 已退回: '退回修改', 停用: '尚未開始' };
function renderJoin() {
  const m = S.me;
  const names = new Map((S.applyProjects || S.projects || []).map((p) => [p.id, p.name]));
  const assign = m.assign || [];
  const html = [];
  if (m.state === 'member') {
    const links = [
      ...(isApprover() ? [['approve', '✅', '核准團隊成員', '核准申請加入你專案的成員']] : []),
      ...(isManager() ? [['team', '📊', '團隊進度', '各組進度、逾期與待審核']] : []),
      ['work', '🗂', '我的工作', '我的進度、本週到期、退回修改'],
      ['cloud', '☁️', '雲端資料夾', '企劃、劇本、美術等七個資料夾']];
    html.push(`<div class="status"><div class="big">🎬</div><h2>${esc(m.name)}，你已是團隊成員</h2>
      <p class="lead">下方選單會依你的最高角色（${esc(topRole())}）自動切換。</p></div>
      <div class="links">${links.map(([v, ic, t, d]) => `<a class="link" href="?v=${v}"><span class="ic">${ic}</span><span><b>${t}</b><small>${d}</small></span></a>`).join('')}</div>`);
  } else {
    html.push(`<h1>加入團隊成員</h1><p class="lead">${m.state === 'pending' ? '申請審核中，該專案的製片人核准後，下方選單會自動換成團隊版。'
      : m.state === 'rejected' ? '上次的申請沒有通過，可以重新申請。' : '選擇要加入的專案與角色，由該專案的製片人核准。'}</p>`);
  }
  if (assign.length) {
    html.push(`<section class="card"><h2>我的專案角色<span class="count">${assign.length}</span></h2><ul class="tasks">${assign.map((a) => `<li>
      <span class="t-name">${esc(names.get(a.pid) || '專案')}</span><span class="t-meta">${esc(a.role)}</span>
      <span class="t-side"><span class="chip" data-s="${esc(STATUS_CHIP[a.status] || '尚未開始')}">${esc(a.status)}</span></span></li>`).join('')}</ul></section>`);
  }
  const f = S.form;
  const open = (S.applyProjects || []).filter((p) => p.status === '進行中');
  html.push(`<section class="card"><h2>${m.state === 'member' ? '申請加入其他專案或角色' : '申請資料'}</h2>
    ${S.applyProjects ? '' : '<p class="empty">讀取專案中…</p>'}
    <label class="f">真實姓名 <b>*</b><input id="fName" value="${esc(f.name)}" autocomplete="name" maxlength="40"></label>
    <label class="f">專案 <b>*</b><select id="fProject"><option value="">請選擇</option>
      ${open.map((p) => `<option value="${esc(p.id)}" ${p.id === f.project ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
    <label class="f">角色 <b>*</b><select id="fRole"><option value="">請選擇</option>
      ${APPLY_ROLES().map((r) => `<option ${r === f.role ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
    <p class="empty">製片人的申請由平台管理者核准，其他角色由該專案的製片人核准。同一個人可以申請多個專案或多個角色；已經有人擔任的角色不能再申請。</p>
    <label class="f">補充說明（選填）<textarea id="fNote" maxlength="300">${esc(f.note)}</textarea></label>
  </section>`);
  $('#app').innerHTML = html.join('');
  $('#bar').hidden = false;
  $('#barIn').innerHTML = `<button class="primary" id="send" ${S.busy ? 'disabled' : ''}>${S.busy ? '送出中…' : '送出申請'}</button>`;
}

// 五種狀態加起來就是總項目數，一眼看完全部；另加已逾期（跨狀態，不計入總數）。我的工作、團隊進度共用
const statusTiles = (s) => tiles([
  ['尚未開始', s.counts['尚未開始'], '', 'status:尚未開始'], ['執行中', s.counts['執行創作中'], '', 'status:執行創作中'],
  ['待審核', s.counts['待審核'], 'review', 'status:待審核'], ['退回修改', s.counts['退回修改'], 'warn', 'status:退回修改'],
  ['已核准', s.counts['已核准'], 'done', 'status:已核准'], ['已逾期', s.overdue, 'warn', 'overdue'],
], 'six');

// ---- 我的工作（2026-11-02 起併入原本的我的進度）：上方看整體進度與六格數字，下方是要處理的工作 ----
function renderWork() {
  const v = buildMine({ tasks: S.tasks, roles: rolesIn(S.projectId), rolesFor: rolesIn, roleOf: S.roleOf, projectId: S.projectId });
  const opts = { today: v.today };
  // 已經是成員的人也能再申請別的專案或角色
  const applyLink = `<a class="link" href="?v=join"><span class="ic">➕</span><span><b>申請新專案的職位</b>
    <small>七個角色都能申請；看我在各專案的角色與申請狀態</small></span></a>`;
  if (!v.summary.total) {
    $('#app').innerHTML = `<p class="empty center">${S.projectId === 'all' ? '你參與的專案' : '這個專案'}目前沒有指派給你的任務</p>${applyLink}`;
    setFoot(v); return;
  }
  const html = [progressCard(S.projectId === 'all' ? '我的總工作量（全部專案）' : '我的進度', v.summary), statusTiles(v.summary)];
  if (S.filter) {
    $('#app').innerHTML = [html[1], ...filteredView(v)].join('');
    setFoot(v);
    return;
  }
  if (v.lists.returned.length) html.push(listCard('退回修改・請重新提交', v.lists.returned, opts));
  if (v.lists.overdue.length) html.push(listCard('已逾期', v.lists.overdue, opts));
  html.push(listCard('本週到期', v.lists.thisWeek, opts));
  const later = v.lists.later.filter((t) => t.status !== '退回修改');
  html.push(`<details class="card"><summary>之後的工作<span class="count">${later.length}</span></summary>${taskList(later, opts)}</details>`);
  html.push(`<details class="card"><summary>各階段</summary>${stageRows(v.stages)}</details>`, applyLink);
  $('#app').innerHTML = html.join('');
  setFoot(v);
}

// ---- 團隊進度的主體 ----
function progressBody(v, { showRole = false } = {}) {
  const opts = { today: v.today, showRole };
  return [
    progressCard(v.group && v.group !== '全部' ? `${v.group}的進度` : S.projectId === 'all' ? '團隊總工作量（全部專案）' : '團隊進度', v.summary),
    statusTiles(v.summary),
    `<section class="card"><h2>各階段</h2>${stageRows(v.stages)}</section>`,
    ...v.statuses.map((g) => `<details class="card" ${g.status === '退回修改' || g.status === '待審核' ? 'open' : ''}>
      <summary><span class="chip" data-s="${g.status}">${g.status}</span> ${g.tasks.length} 項</summary>${taskList(g.tasks, opts)}</details>`),
  ];
}
// ---- 雲端資料夾：專案 IP 資料庫的七個分類（Notion 的「雲端連結」），點了用外部瀏覽器或雲端硬碟 App 開啟 ----
const CLOUD_ICON = [['企劃', '📑'], ['劇本', '📝'], ['美術', '🎨'], ['動畫', '🎞'], ['聲音', '🎵'], ['交付', '📦'], ['法律', '⚖️']];
const cloudIcon = (name) => (CLOUD_ICON.find(([k]) => name.includes(k)) || [, '📁'])[1];
function renderCloud() {
  if (!S.links) { $('#app').innerHTML = '<p class="blocked">讀取雲端資料夾中…</p>'; return; }
  // 只列我有角色的專案（Make 已經篩過，這裡再擋一次）
  const names = new Map((S.applyProjects || S.projects || []).map((p) => [p.id, p.name]));
  const pids = [...new Set(S.links.map((l) => l.pid))].filter((pid) => rolesIn(pid).length);
  if (!pids.includes(S.cloudPid)) S.cloudPid = pids[0] ?? null;
  const sel = $('#project');
  sel.innerHTML = pids.map((pid) => `<option value="${esc(pid)}" ${pid === S.cloudPid ? 'selected' : ''}>${esc(names.get(pid) || '專案')}</option>`).join('');
  sel.hidden = pids.length < 2;
  if (!S.cloudPid) return blocked('還沒有雲端資料夾', '你參與的專案還沒設定雲端資料夾，請洽製片人。');
  const list = S.links.filter((l) => l.pid === S.cloudPid);
  $('#app').innerHTML = `<p class="lead">${esc(names.get(S.cloudPid) || '')}・點一下用雲端硬碟開啟</p>
    <div class="links">${list.map((l) => (l.url
    ? `<a class="link" href="${esc(l.url)}" data-open="${esc(l.url)}"><span class="ic">${cloudIcon(l.name)}</span><span><b>${esc(l.name)}</b><small>開啟資料夾 ›</small></span></a>`
    : `<div class="link muted"><span class="ic">${cloudIcon(l.name)}</span><span><b>${esc(l.name)}</b><small>尚未設定連結</small></span></div>`)).join('')}</div>`;
  $('#foot').textContent = '看不到資料夾內容時，請製片人把你的 Google 帳號加入共用';
}
function openFolder(url) {
  if (IN_LIFF_HOST && liff.isInClient()) liff.openWindow({ url, external: true });
  else window.open(url, '_blank', 'noopener');
}
const normalizeLink = (r) => {
  const p = r.properties_value || {};
  const text = (v) => (Array.isArray(v) ? v.map((x) => x.plain_text ?? '').join('') : v || '');
  return { name: text(p['名稱']) || '資料夾', url: p['雲端連結'] || '', pid: plainId(p['專案']?.[0]?.id), order: p['排序'] ?? 99 };
};
async function loadLinks() {
  const r = await api.links();
  S.links = (r.links || []).filter((l) => l && l.id).map(normalizeLink).sort((a, b) => a.order - b.order);
}

// ---- 團隊進度 ----
function renderTeam() {
  const groups = ['全部', ...S.roles.creators, ...S.roles.managers];
  $('#tabs').innerHTML = groups.map((g) => `<button data-group="${g}" aria-pressed="${g === S.group}">${g}</button>`).join('');
  $('#tabs').hidden = false;
  const v = buildTeam({ tasks: S.tasks, roles: S.roles, roleOf: S.roleOf, projectId: S.projectId, projects: scopeIds(), group: S.group });
  // 團隊進度點數字：留在團隊進度，用目前的組別篩選
  if (S.filter) {
    $('#app').innerHTML = filteredView(v, { showRole: S.group === '全部' }).join('');
    setFoot(v);
    return;
  }
  const html = progressBody(v, { showRole: S.group === '全部' });
  if (S.group === '全部') {
    const roleRows = `<div class="rows">${v.roles.map((r) => {
      const nums = [`核准 ${r.done}/${r.total}`, r.counts['待審核'] ? `待審 ${r.counts['待審核']}` : null,
        r.counts['退回修改'] ? `<span class="alert">退回 ${r.counts['退回修改']}</span>` : null,
        r.overdue ? `<span class="alert">逾期 ${r.overdue}</span>` : null].filter(Boolean).join(' · ');
      return `<div><div class="row-head"><span class="r-name">${esc(r.role)}</span><span class="r-nums">${nums}</span></div>
        ${statusBar(r.counts, r.total, true)}</div>`;
    }).join('')}</div>`;
    html.splice(2, 0, `<section class="card"><h2>各組進度</h2>${roleRows}</section>`);
    // 待審核放在最前面：點進去就能核准或退回
    if (v.lists.pendingReview.length) {
      html.splice(1, 0, listCard('待審核・點進去核准或退回', v.lists.pendingReview, { today: v.today, showRole: true }));
    }
    if (v.unmapped.length) {
      html.push(`<details class="card warn-card"><summary>⚠ ${v.unmapped.length} 項任務的執行職掌對不到角色</summary>
        <p class="empty">請在 Notion 把「執行職掌」改成七個角色之一。</p>
        <ul class="tasks">${v.unmapped.map((t) => `<li><span class="t-name">${esc(t.name)}</span><span class="t-meta">目前：${esc(t.executor || '（空白）')}</span></li>`).join('')}</ul></details>`);
    }
    if (canPush(S.projectId)) html.push(pushCard());
  }
  if (isAdmin()) html.push(setupCard());
  $('#app').innerHTML = html.join('');
  setFoot(v);
  if (S.group === '全部' && canPush(S.projectId) && S.push?.pid !== S.projectId) loadPush(S.projectId);
}

// ---- LINE 進度推播（📣 專案推播）：該專案的製片人、導演可以設定；推給專案全體已核准成員 ----
const canPush = (pid) => pid !== 'all' && (isAdmin() || rolesIn(pid).some((r) => r === '製片人' || r === '導演'));
const HOURS = Array.from({ length: 24 }, (_, h) => h);
function parsePush(results) {
  const q = results?.[0]?.properties || {};
  const rt = (x) => (x?.rich_text || []).map((t) => t.plain_text).join('');
  return {
    daily: !!q['每日推播']?.checkbox, hour: q['推播時間']?.number ?? 9, instant: !!q['即刻推播']?.checkbox,
    by: rt(q['設定人']), at: q['設定時間']?.date?.start || '', last: q['上次推播時間']?.date?.start || '',
  };
}
function pushCard() {
  const p = S.push;
  if (!p || p.pid !== S.projectId || !p.data) {
    return `<section class="card"><h2>📣 LINE 進度推播</h2><p class="empty">${p?.error ? '讀不到推播設定，請稍後再試' : '讀取中…'}</p></section>`;
  }
  const d = p.data;
  const meta = [d.by && d.at ? `由 ${esc(d.by)} 於 ${fmtTime(d.at)} 設定` : null, d.last ? `上次推播 ${fmtTime(d.last)}` : '還沒推播過']
    .filter(Boolean).join('・');
  return `<section class="card push-card"><h2>📣 LINE 進度推播</h2>
    <p class="lead">推給這個專案的所有成員：各職掌的件數，和上次推播相比「上次→現在」。</p>
    <label class="switch"><input type="checkbox" id="pDaily" ${d.daily ? 'checked' : ''}> 每日推播，每天
      <select id="pHour">${HOURS.map((h) => `<option value="${h}" ${h === d.hour ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select></label>
    <label class="switch"><input type="checkbox" id="pInstant" ${d.instant ? 'checked' : ''}> 即刻推播（測試用）：從 LINE 交件或審核改了狀態，就立刻推給全專案</label>
    <div class="push-actions"><button class="primary" id="pSave" ${p.busy ? 'disabled' : ''}>${p.busy === 'save' ? '儲存中…' : '儲存設定'}</button>
      <button class="ghost" id="pNow" ${p.busy ? 'disabled' : ''}>${p.busy === 'now' ? '推播中…' : '現在推一次'}</button></div>
    <small class="muted">${meta}・推播會用到 LINE 官方帳號的每月訊息額度</small></section>`;
}
async function loadPush(pid) {
  S.push = { pid, data: null };
  try { S.push.data = parsePush((await api.push_get(pid)).push); }
  catch (x) { if (handleApiError(x)) return; S.push.error = true; }
  if (S.view === 'team') render();
}
async function savePush(now) {
  const p = S.push;
  if (!p?.data || p.busy) return;
  const f = { pid: p.pid, daily: $('#pDaily').checked ? '1' : '0', hour: $('#pHour').value, instant: $('#pInstant').checked ? '1' : '0',
    pname: (S.projects || []).find((x) => x.id === p.pid)?.name || '' };
  if (now && !confirm('現在就推一則進度給這個專案的所有成員？')) return;
  p.busy = now ? 'now' : 'save'; render();
  try {
    if (now) { await api.push_now(p.pid); toast('已送出推播，成員的 LINE 會收到進度'); }
    else { await api.push_set(f); toast(f.daily === '1' || f.instant === '1' ? '已儲存，推播已開啟' : '已儲存，推播已關閉'); }
    p.busy = false; await loadPush(p.pid);
  } catch (x) {
    p.busy = false;
    if (!handleApiError(x)) { toast('沒有成功，請再試一次'); render(); }
  }
}

// ---- 建立專案工作（平台管理者）：多專案任務總管理裡「進行中」但還沒有任務的專案，從範本任務複製一份 ----
function setupCard() {
  const has = new Set((S.tasks || []).map((t) => t.projectId));
  const todo = (S.allProjects || []).filter((p) => p.status === '進行中' && !has.has(p.id));
  if (!todo.length) return '';
  return `<section class="card"><h2>🎬 建立專案工作</h2>
    <p class="lead">這些專案還沒有任務。按下後會從「動畫專案範本任務」複製 47 項任務，並建好 IP 資料庫七個分類與推播設定（關閉）。</p>
    <ul class="tasks setup-list">${todo.map((p) => `<li><span class="t-name">${esc(p.name)}</span>
      <button class="primary small" data-setup="${p.id}" ${S.setupBusy ? 'disabled' : ''}>${S.setupBusy === p.id ? '建立中…' : '建立專案工作'}</button></li>`).join('')}</ul></section>`;
}
async function setupProject(pid) {
  const p = (S.allProjects || []).find((x) => x.id === pid);
  if (!p || S.setupBusy || !confirm(`為「${p.name}」建立專案工作？`)) return;
  S.setupBusy = pid; render();
  try {
    await api.setup(pid, p.name);
    toast('正在建立，約一分鐘後重新整理就會看到任務');
    setTimeout(async () => { S.setupBusy = null; try { await loadTasks(); } catch { /* 下次打開再讀 */ } render(); }, 60000);
  } catch (x) {
    S.setupBusy = null;
    if (!handleApiError(x)) { toast(x.code === 'exists' ? '這個專案已經有任務了' : '建立失敗，請再試一次'); render(); }
  }
}

// ---- 核准團隊成員 ----
function renderApprove() {
  if (!S.pending) { $('#app').innerHTML = '<p class="blocked">讀取申請中…</p>'; return; }
  if (!S.pending.length) {
    $('#app').innerHTML = '<div class="status"><div class="big">✅</div><h2>目前沒有待核准的申請</h2><p class="lead">有人申請加入你擔任製片人的專案時，會出現在這裡。</p></div>';
    return;
  }
  $('#app').innerHTML = `<section class="card"><h2>待核准<span class="count">${S.pending.length}</span></h2>
    ${S.pending.map((p) => `<div class="applicant" data-id="${esc(p.id)}">
      <div><b>${esc(p.name)}</b> <span class="meta">${esc(p.pname)}</span></div>
      <div class="meta">申請角色：${esc(p.role || '—')}${p.role === '製片人' ? '（需平台管理者核准）' : ''}・${esc(p.time)}</div>
      ${p.note ? `<div class="meta">說明：${esc(p.note)}</div>` : ''}
      <div class="actions"><select aria-label="核准的角色">${APPLY_ROLES().filter((r) => isAdmin() || r !== '製片人')
        .map((r) => `<option ${r === p.role ? 'selected' : ''}>${r}</option>`).join('')}</select>
        <button class="btn ok" data-act="approve" ${p.busy ? 'disabled' : ''}>核准</button>
        <button class="btn no" data-act="reject" ${p.busy ? 'disabled' : ''}>退回</button></div>
    </div>`).join('')}</section>
    <p class="empty center">${isAdmin() ? '你是平台管理者，列出所有專案的申請（含製片人）。' : '只會列出你擔任製片人的專案；製片人的申請由平台管理者核准。'}
    核准後會記下核准人，對方的 LINE 選單會自動換成對應角色的版本。</p>`;
}

// ---- 工作項目（明細、交件、審核） ----
const plain = (v) => (Array.isArray(v) ? v.map((x) => x.plain_text ?? x.text?.content ?? '').join('') : v?.name ?? (typeof v === 'string' ? v : ''));
const when = (iso) => (iso ? `（${fmtTime(iso)}）` : '');
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const SAVE_STATUSES = ['尚未開始', '執行創作中', '待審核'];
// 和 Make 的規則相同（tools/make_blueprints.py 的 version_v）：第一次送審沿用或從 V1 開始，之後每次送審加一
function nextVersion(t) {
  if (!t.submittedAt || t.status === '待審核' || t.version === '最終定案') return t.version || 'V1';
  const n = Number((t.version || 'V0').slice(1));
  return Number.isInteger(n) && n < 30 ? `V${n + 1}` : t.version;
}
const nextVersionHint = (t) => (t.status === '待審核' ? `維持 ${nextVersion(t)}` : `會記為 ${nextVersion(t)}`);
const MAX_FILE = 3 * 1024 * 1024;   // Make webhook 一次最多約 5MB，base64 會變大三分之一

function parseDetail(r) {
  const p = r.task || {};
  const files = Array.isArray(p['交付檔案上傳']) ? p['交付檔案上傳'] : [];
  return {
    // own：我負責這個職掌；canReview：我是這項工作的審核者（總監的工作→導演，導演／副製片／製片人的工作→製片人）
    id: r.id, own: r.own === 'yes', canReview: r.canReview === 'yes', reviewerRole: r.reviewer || '',
    name: plain(p['任務名稱']), stage: plain(p['階段']), workflow: plain(p['工作流程']), check: plain(p['查核點']),
    executor: plain(p['執行職掌']), status: plain(p['狀態']) || '尚未開始', version: plain(p['版本號']),
    due: (p['預計交付日']?.start || '').slice(0, 10) || null,
    link: typeof p['交付雲端連結'] === 'string' ? p['交付雲端連結'] : '',
    files: files.map((f) => ({ name: f.name || '檔案', url: f.url || f.external?.url || f.file?.url || '' })).filter((f) => f.url),
    note: plain(p['執行者留言']), comment: plain(p['審核意見']),
    reviewer: [plain(p['審核身分']), plain(p['審核人'])].filter(Boolean).join(' '), reviewedAt: p['審核日期']?.start || '',
    submitter: plain(p['提交人']), submittedAt: p['提交時間']?.start || '',
    logs: (r.logs || []).map((l) => {
      const q = l.properties || {};
      const rt = (x) => (x?.rich_text || x?.title || []).map((t) => t.plain_text).join('');
      return {
        action: q['動作']?.select?.name || '', status: q['狀態']?.select?.name || '', version: q['版本號']?.select?.name || '',
        role: q['身分']?.select?.name || '', name: rt(q['姓名']), time: q['時間']?.date?.start || l.created_time,
        note: rt(q['意見']), link: q['雲端連結']?.url || '', file: q['上傳檔案']?.url || '',
      };
    }),
  };
}

const safeUrl = (u) => (/^https:\/\//.test(u || '') ? u : '');

// ---- 交付檔案：雲端硬碟的檔案顯示縮圖（圖片、PDF、影片都有），讀不到縮圖就只留連結 ----
const driveId = (u) => (String(u || '').match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?id=)([\w-]{20,})/) || [])[1] || '';
function fileItem(url, label) {
  if (!safeUrl(url)) return '';
  const id = driveId(url);
  if (!id) return `<a class="file-link" href="${esc(url)}" target="_blank" rel="noopener">🔗 ${esc(label)}</a>`;
  return `<a class="thumb" href="${esc(url)}" target="_blank" rel="noopener">
    <img src="https://drive.google.com/thumbnail?id=${esc(id)}&sz=w480" alt="${esc(label)}" loading="lazy" referrerpolicy="no-referrer">
    <span>${esc(label)}</span></a>`;
}
const deliverables = (items) => {
  const html = items.map(([u, label]) => fileItem(u, label)).filter(Boolean);
  return html.length ? `<div class="files">${html.join('')}</div>` : '';
};
// 縮圖讀不到（沒有權限、不是圖片）時換成文字連結
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName === 'IMG' && img.closest('.thumb')) { img.closest('.thumb').classList.add('no-img'); img.remove(); }
}, true);

const quote = (label, text, cls = '') => `<div class="quote ${cls}"><b>${label}</b>${esc(text) || '<span class="muted">（沒有寫）</span>'}</div>`;
const who = (role, name) => [role, name].filter(Boolean).join(' ');
const ACTION_ICON = { 送審: '📤', 退回: '↩️', 核准: '✅', 改狀態: '✏️' };

// 審核紀錄依版本分組（新版本在上，同一版內依時間順序），一眼看出每一版「怎麼交、怎麼被審」
function rounds(logs) {
  const map = new Map();
  for (const l of logs) {   // logs 由新到舊
    const k = l.version || '—';
    if (!map.has(k)) map.set(k, []);
    map.get(k).unshift(l);
  }
  return [...map].map(([version, items]) => {
    const last = items[items.length - 1];
    const result = { 核准: '已核准', 退回: '退回修改', 送審: '待審核' }[last.action] || '製作中';
    return { version, items, result };
  });
}

// 最上方「目前進度」：用一句話說明現在輪到誰、要做什麼；送審時把上一版的審核意見和這一版的說明放在一起
function statusCard(t) {
  const lastReturn = t.logs.find((l) => l.action === '退回');
  const lastSubmit = t.logs.find((l) => l.action === '送審');
  const prevReturn = lastReturn && lastReturn.version !== t.version ? lastReturn : null;
  const parts = [];
  if (t.status === '待審核') {
    parts.push(t.own
      ? `<p>你已送審 <b>${esc(t.version)}</b>${when(t.submittedAt)}，等${esc(t.reviewerRole || '審核者')}審核。</p>`
      : `<p><b>${esc(t.submitter || '執行者')}</b>${t.submittedAt ? ` 在 ${fmtTime(t.submittedAt)}` : ''} 送審 <b>${esc(t.version)}</b>${t.canReview ? '，請審核。' : `，等${esc(t.reviewerRole || '審核者')}審核。`}</p>`);
    if (prevReturn) {
      parts.push(`<div class="compare">${quote(`上一版 ${esc(prevReturn.version)} 的審核意見・${esc(who(prevReturn.role, prevReturn.name))}`, prevReturn.note, 'warn')}
        ${quote(`這一版 ${esc(t.version)} 的說明・${esc(lastSubmit?.name || t.submitter)}`, lastSubmit?.note || '')}</div>`);
    } else if (lastSubmit?.note) {
      parts.push(quote(`送審說明・${esc(lastSubmit.name)}`, lastSubmit.note));
    }
  } else if (t.status === '退回修改') {
    parts.push(`<p><b>${esc(t.version)}</b> 被 ${esc(t.reviewer)} 退回${when(t.reviewedAt)}。</p>`, quote('審核意見', t.comment, 'warn'));
    if (t.own) parts.push(`<p class="muted">修改後，狀態選「待審核」儲存即可再送審，會記為 <b>${esc(nextVersion(t))}</b>。</p>`);
  } else if (t.status === '已核准') {
    parts.push(`<p><b>${esc(t.version)}</b> 已由 ${esc(t.reviewer)} 核准${when(t.reviewedAt)}。</p>`);
    if (t.comment) parts.push(quote('審核意見', t.comment));
  } else if (lastReturn) {
    parts.push(`<p>${esc(lastReturn.version)} 被退回後修改中（${esc(t.status)}）。</p>`, quote(`上一次的審核意見・${esc(who(lastReturn.role, lastReturn.name))}`, lastReturn.note, 'warn'));
  } else {
    parts.push(`<p>還沒送審（${esc(t.status)}）。</p>`);
    if (t.own) parts.push(`<p class="muted">上傳檔案或貼雲端連結，狀態選「待審核」儲存就會送審，記為 <b>${esc(nextVersion(t))}</b>。</p>`);
  }
  return `<section class="card now" data-s="${esc(t.status)}"><h2>目前進度</h2>${parts.join('')}</section>`;
}

function historyCard(t) {
  if (!t.logs.length) return '';
  return `<section class="card"><h2>修改歷程<span class="count">${rounds(t.logs).length} 版</span></h2>${rounds(t.logs).map((r, i) => `
    <details class="round" ${i < 2 ? 'open' : ''}><summary><b>${esc(r.version)}</b> <span class="chip" data-s="${esc(r.result)}">${esc(r.result)}</span></summary>
    <ol class="log">${r.items.map((l) => {
      const review = l.action === '核准' || l.action === '退回';
      return `<li><div>${ACTION_ICON[l.action] || '•'} <b>${esc(l.action)}</b> ${esc(who(l.role, l.name))} <small class="muted">${fmtTime(l.time)}</small></div>
        ${l.note ? quote(review ? '審核意見' : '說明', l.note, l.action === '退回' ? 'warn' : '') : ''}
        ${deliverables([[l.file, '上傳的檔案'], [l.link, '雲端連結']])}</li>`;
    }).join('')}</ol></details>`).join('')}</section>`;
}

function renderTask() {
  const d = S.detail;
  if (!d.data) { $('#app').innerHTML = '<p class="blocked">讀取工作項目中…</p>'; return; }
  const t = d.data;
  const canEdit = t.own && t.status !== '已核准';
  const canReview = t.canReview && t.status === '待審核';
  const current = deliverables([...t.files.map((f) => [f.url, f.name]), [t.link, '雲端連結']]);
  const html = [`<section class="card">
    <div class="row-head"><span class="chip" data-s="${esc(t.status)}">${esc(t.status)}</span><span class="r-nums">${esc(t.version || '尚無版本')}</span></div>
    <h1 class="t-title">${esc(t.name)}</h1>
    <p class="lead">${esc([t.stage, t.workflow, t.executor].filter(Boolean).join(' · '))}</p>
    <dl><dt>預計交付</dt><dd>${fmtDate(t.due)}</dd></dl>
    ${t.check ? `<p class="check">${esc(t.check)}</p>` : ''}
  </section>`, statusCard(t)];
  html.push(`<section class="card"><h2>目前交付${t.version ? `・${esc(t.version)}` : ''}</h2>${current || '<p class="empty">還沒有交付檔案或連結</p>'}</section>`);
  if (canReview) {
    html.push(`<section class="card review-card"><h2>審核 ${esc(t.version)}</h2>
      <label class="f">審核意見（退回時必填，會留在修改歷程讓下一版對照）<textarea id="rComment" maxlength="1000" placeholder="例如：角色比例再修正，背景色調偏冷"></textarea></label>
      <div class="actions2"><button class="btn ok" data-review="approve" ${d.busy ? 'disabled' : ''}>核准</button>
        <button class="btn no" data-review="return" ${d.busy ? 'disabled' : ''}>退回修改</button></div>
      <p class="empty">送出後會記下你的身分（${esc(t.reviewerRole)}）與姓名。</p></section>`);
  }
  if (canEdit) {
    const status = SAVE_STATUSES.includes(t.status) ? t.status : '執行創作中';
    html.push(`<section class="card"><h2>${t.status === '退回修改' ? '修改後重新交件' : '交件與進度'}</h2>
      <label class="f">狀態<select id="sStatus">${SAVE_STATUSES.map((s) => `<option ${s === status ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      <p class="empty">版本號與送審時間由系統自動處理：送審時${nextVersionHint(t)}。</p>
      <label class="f">雲端硬碟連結<input id="sLink" type="url" inputmode="url" placeholder="https://drive.google.com/…" value="${esc(t.link)}"></label>
      <label class="f">上傳檔案（照片會自動縮小；其他檔案 3MB 以內，大檔請放雲端貼連結）
        <input id="sFile" type="file"></label>
      ${d.file ? `<p class="empty">已選擇：${esc(d.file.label)}</p>` : ''}
      <label class="f">這次的說明（改了哪裡、想請審核者看什麼）
        <textarea id="sNote" maxlength="1000" placeholder="${t.status === '退回修改' ? '例如：依意見把角色比例調高，背景改暖色' : '例如：先交三款造型，想確認方向'}"></textarea></label>
    </section>`);
    $('#bar').hidden = false;
    $('#barIn').innerHTML = `<button class="primary" id="saveTask" ${d.busy ? 'disabled' : ''}>${d.busy ? '儲存中…' : '儲存'}</button>`;
  } else if (t.own && t.status === '已核准') {
    html.push('<p class="empty center">這項工作已核准，不能再修改。需要修改請洽製片人。</p>');
  }
  html.push(historyCard(t));
  $('#app').innerHTML = html.join('');
}

// ===== 頁內導覽 =====
// LIFF 沒有瀏覽器的上一頁鍵，按右上角 ✕ 會直接關掉整個頁面回到 LINE。所以每往下一層（點工作、點數字篩選、
// 前往我的工作）都記一筆瀏覽紀錄：左上角「‹ 返回」和手機的返回鍵都回到上一個畫面。
// 紀錄內容：v 畫面、f 篩選、g 團隊進度的組別、id 工作項目、d 第幾層（0＝從 LINE 選單打開的第一頁）
const depth = () => history.state?.d || 0;
const homeView = () => (!isMember() ? 'join' : isManager() ? 'team' : 'work');
// 從 LINE 選單直接打開的第一頁不用返回；工作項目、篩選後的清單一定有返回（沒有上一頁就回這個角色的首頁）
const canGoBack = () => depth() > 0 || S.view === 'task' || !!S.filter;
const snapshot = () => ({ v: S.view, f: S.filter, g: S.group, id: S.view === 'task' ? S.detail.id : null });

// 網址跟著畫面改（保留 as、project 等其他參數），重新整理會停在同一個畫面
function urlOf(s) {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries({ v: s.v, f: s.f, id: s.id })) if (v == null) q.delete(k); else q.set(k, v);
  return `?${q}`;
}

async function go(next, { replace = false } = {}) {
  const s = { ...snapshot(), id: null, ...next };
  s.d = depth() + (replace ? 0 : 1);
  s.p = replace ? history.state?.p : S.view;   // 從哪個畫面來的
  if (replace && s.d === 0) delete s.p;
  history[replace ? 'replaceState' : 'pushState'](s, '', urlOf(s));
  await show(s);
}

async function show(s) {
  S.view = s.v; S.filter = s.f || null; S.group = s.g || '全部';
  scrollTo(0, 0);
  try {
    if (s.v === 'task') return await openTask(s.id);
    render();
    if (s.v === 'join' || !isMember()) { await loadApplyProjects(); render(); return; }
    // 核准團隊成員：申請要先知道專案名稱，所以和任務一起讀
    if (s.v === 'approve' && isApprover()) {
      if (!S.tasks) await loadTasks();
      S.pending = parseApps((await api.pending()).apps); render(); return;
    }
    if (s.v === 'cloud' && !S.links) { await Promise.all([loadLinks(), loadApplyProjects()]); render(); return; }
    // 交件或審核後清單會清空，回到清單時重新讀取
    if (['work', 'progress', 'team'].includes(s.v) && !S.tasks) { await loadTasks(); render(); }
  } catch (x) {
    if (!handleApiError(x)) blocked('暫時無法讀取', '請稍後再試。');
  }
}

function goBack() {
  if (depth() > 0) return history.back();
  // 沒有上一頁（從 LINE 選單或連結直接打開）：工作項目回角色首頁，篩選清單回同一頁的全部
  return go({ v: S.view === 'task' ? homeView() : S.view, f: null }, { replace: true });
}
window.addEventListener('popstate', (e) => { if (e.state) show(e.state); });

// 我的進度點數字 → 到我的工作看那些工作；我的工作、團隊進度點數字 → 原畫面篩選。key 空字串＝顯示全部（取代目前這筆）
function applyFilter(key) {
  // 在同一頁篩選的（我的工作、團隊進度），顯示全部＝回上一頁，免得返回時又停在同一頁
  if (!key) return depth() > 0 && history.state?.p === S.view ? history.back() : go({ f: null }, { replace: true });
  return go({ v: S.view, f: key });
}

// 只負責讀取並顯示工作項目；換畫面與返回由 go／show 處理。交件、審核後直接呼叫它重新讀取
async function openTask(id) {
  S.detail = { id, data: null, file: null, busy: false };
  S.view = 'task';
  render();
  try { S.detail.data = parseDetail(await api.task(id)); render(); }
  catch (x) {
    if (handleApiError(x)) return;
    blocked(x.code === 'not_found' ? '找不到這項工作' : '暫時無法讀取', x.code === 'not_found' ? '可能已被刪除或移到其他專案。' : '請稍後再試。');
  }
}

// 照片縮成 1600px JPEG；其他檔案原樣讀成 base64
async function readFile(file) {
  if (/^image\/(jpeg|png|webp|heic|heif)/.test(file.type)) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = url; });
      const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const data = c.toDataURL('image/jpeg', 0.85);
      return { b64: data.slice(data.indexOf(',') + 1), ext: 'jpg', label: `${file.name}（已縮小）` };
    } finally { URL.revokeObjectURL(url); }
  }
  if (file.size > MAX_FILE) throw new Error('too_big');
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'bin';
  return { b64: btoa(bin), ext, label: file.name };
}

async function saveTask() {
  const d = S.detail;
  const f = {
    id: d.id, status: $('#sStatus').value,
    link: $('#sLink').value.trim(), note: $('#sNote').value.trim(),
  };
  if (f.link && !/^https:\/\//.test(f.link)) return toast('連結要以 https:// 開頭');
  if (f.status === '待審核' && !f.link && !d.file && !d.data.link && !d.data.files.length) return toast('送審前請上傳檔案或貼上雲端連結');
  if (d.file) { f.file = d.file.b64; f.ext = d.file.ext; }
  d.busy = true; render();
  try {
    await api.save(f);
    toast(f.status === '待審核' ? '已送審，審核者可在團隊進度看到' : '已儲存');
    S.tasks = null;   // 回到清單時重新讀取
    await openTask(d.id);
  } catch (x) {
    d.busy = false;
    if (handleApiError(x)) return;
    toast(x.code === 'locked' ? '這項工作已核准，不能再修改' : '儲存失敗，請再按一次');
    render();
  }
}

async function reviewTask(decision) {
  const d = S.detail;
  const comment = $('#rComment').value.trim();
  if (decision === 'return' && !comment) return toast('退回時請寫下審核意見');
  if (decision === 'approve' && !confirm(`確定核准「${d.data.name}」？核准後執行者不能再修改。`)) return;
  d.busy = true; render();
  try {
    await api.review(d.id, decision, comment);
    toast(decision === 'approve' ? '已核准' : '已退回，成員可在我的工作看到審核意見');
    S.tasks = null;
    await openTask(d.id);
  } catch (x) {
    d.busy = false;
    if (handleApiError(x)) return;
    toast(x.code === 'bad_target' ? '這項工作已經不是待審核了' : '操作失敗，請再試一次');
    if (x.code === 'bad_target') return openTask(d.id);
    render();
  }
}

function setFoot(v) {
  $('#foot').textContent = `本週 ${fmtDate(v.week.start)}–${fmtDate(v.week.end)}・資料來自 Notion`;
}

// ===== 操作 =====
document.addEventListener('input', (e) => {
  if (e.target.id === 'fName') S.form.name = e.target.value;
  if (e.target.id === 'fNote') S.form.note = e.target.value;
});
document.addEventListener('change', async (e) => {
  if (e.target.id === 'fRole') S.form.role = e.target.value;
  if (e.target.id === 'fProject') S.form.project = e.target.value;
  if (e.target.id === 'project') { S.cloudPid = e.target.value; render(); }
  if (e.target.id === 'sFile' && e.target.files[0]) {
    // 換畫面前先記下其他欄位，重畫後才不會被清掉
    const keep = { status: $('#sStatus').value, link: $('#sLink').value, note: $('#sNote').value };
    try { S.detail.file = await readFile(e.target.files[0]); }
    catch (x) { toast(x.message === 'too_big' ? '檔案超過 3MB，請放到雲端硬碟後貼連結' : '這個檔案讀不到'); return; }
    render();
    $('#sStatus').value = keep.status; $('#sLink').value = keep.link; $('#sNote').value = keep.note;
  }
});
document.addEventListener('click', async (e) => {
  // 頁面裡的「?v=…」連結（前往我的工作等）改成頁內換畫面，才有上一頁可以回
  const link = e.target.closest('a[href^="?v="]');
  if (link) { e.preventDefault(); return go({ v: new URLSearchParams(link.getAttribute('href')).get('v'), f: null }); }
  const folder = e.target.closest('[data-open]');
  if (folder) { e.preventDefault(); return openFolder(folder.dataset.open); }
  const ptab = e.target.closest('[data-project]');
  if (ptab) { S.projectId = ptab.dataset.project; S.push = null; scrollTo(0, 0); return render(); }
  const tab = e.target.closest('[data-group]');
  if (tab) return go({ g: tab.dataset.group }, { replace: true });
  const fb = e.target.closest('[data-filter]');
  if (fb) return applyFilter(fb.dataset.filter);
  const item = e.target.closest('[data-task]');
  if (item && !e.target.closest('a')) return go({ v: 'task', id: item.dataset.task });
  const t = e.target.closest('button');
  if (!t) return;
  if (t.id === 'navBack') return goBack();
  if (t.id === 'edit') { S.editing = true; render(); return; }
  if (t.id === 'cancelEdit') { S.editing = false; render(); return; }
  if (t.id === 'send' && !S.busy) return sendApply();
  if (t.id === 'saveTask' && !S.detail.busy) return saveTask();
  if (t.id === 'pSave') return savePush(false);
  if (t.id === 'pNow') return savePush(true);
  if (t.dataset.setup) return setupProject(t.dataset.setup);
  if (t.dataset.review && !S.detail.busy) return reviewTask(t.dataset.review);
  if (t.dataset.act) return decide(t.closest('.applicant'), t.dataset.act);
});
document.addEventListener('keydown', (e) => {
  const item = e.target.closest?.('[data-task]');
  if (item && e.key === 'Enter') go({ v: 'task', id: item.dataset.task });
});

async function sendApply() {
  // 送出時直接讀畫面上的值：手機 LINE 的下拉選單不一定會觸發 change（2026-10-22 選了製片人卻送出編劇）
  S.form = { name: $('#fName').value, project: $('#fProject').value, role: $('#fRole').value, note: $('#fNote').value };
  const f = { name: S.form.name.trim(), project: S.form.project, role: S.form.role, note: S.form.note.trim() };
  if (!f.name) return toast('請填寫真實姓名');
  if (!f.project) return toast('請選擇專案');
  if (!f.role) return toast('請選擇角色');
  if ((S.me.assign || []).some((a) => a.pid === plainId(f.project) && a.role === f.role && a.status !== '已退回')) {
    return toast('這個專案的這個角色已經申請過了');
  }
  f.pname = (S.applyProjects || []).find((p) => p.id === f.project)?.name || '';
  S.busy = true; render();
  try {
    await api.apply(f);
    S.me = withAssign(await api.me());
    S.busy = false; S.form = { ...S.form, project: '', role: '', note: '' };
    toast(f.role === '製片人' ? '已送出，等待平台管理者核准' : '已送出，等待該專案的製片人核准'); render(); scrollTo(0, 0);
  } catch (x) {
    S.busy = false;
    if (!handleApiError(x)) { toast(x.code === 'taken' ? '這個專案的這個角色已經有人擔任了' : '送出失敗，請再按一次'); render(); }
  }
}

async function loadApplyProjects() {
  if (S.applyProjects) return;
  S.applyProjects = (await api.projects()).projects.map(normalizeProject);
}
const withAssign = (me) => ({ ...me, assign: parseKeys(me.keys) });

async function decide(el, act) {
  const p = S.pending.find((x) => x.id === el.dataset.id);
  if (!p || p.busy) return;
  const role = el.querySelector('select').value;
  if (act === 'reject' && !confirm(`確定退回 ${p.name} 的申請？`)) return;
  p.busy = true; render();
  try {
    if (act === 'approve') await api.approve(p.id, role); else await api.reject(p.id);
    S.pending = S.pending.filter((x) => x !== p);
    toast(act === 'approve' ? `已核准 ${p.name}（${role}）` : `已退回 ${p.name}`);
  } catch (x) {
    p.busy = false;
    if (handleApiError(x)) return;
    toast(x.code === 'taken' ? `這個專案的${role}已經有人擔任了` : x.code === 'bad_target' ? '這筆申請已經被處理過，或需要平台管理者核准' : '操作失敗，請再試一次');
    if (x.code === 'bad_target') S.pending = S.pending.filter((y) => y !== p);
  }
  render();
}

// ===== LIFF 與錯誤處理 =====
function handleApiError(e) {
  if (!(e instanceof ApiError)) return false;
  if (e.code === 'auth' || e.code === 'no_token') {
    // 只自動重新登入一次；兩分鐘內又失敗就停下來，避免無限重新整理、一直消耗 Make 額度
    let last = 0;
    try { last = +sessionStorage.getItem('relogin') || 0; } catch {}
    if (e.code === 'auth' && Date.now() - last > 120000) {
      try { sessionStorage.setItem('relogin', String(Date.now())); } catch {}
      if (liff.isInClient()) location.reload(); else { liff.logout(); liff.login({ redirectUri: location.href }); }
      return true;
    }
    blocked('無法確認你的身分', '請關閉頁面，從 LINE 重新開啟。');
    return true;
  }
  if (e.code === 'forbidden') { blocked('沒有權限', '這個功能只開放給已核准的團隊成員。'); return true; }
  return false;
}

function loadScript(src) {
  return new Promise((ok, fail) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = fail; document.body.append(s); });
}

// 待核准的申請（Notion API 原始格式）。只留我擔任製片人的專案；核准時 Make 會再檢查一次
function parseApps(results) {
  const rt = (x) => (x?.rich_text || x?.title || []).map((t) => t.plain_text).join('');
  const names = new Map((S.projects || []).map((p) => [p.id, p.name]));
  return (results || []).map((r) => {
    const q = r.properties || {};
    const pid = plainId(q['專案']?.relation?.[0]?.id);
    const [name, pname] = rt(q['紀錄']).split('｜');
    return {
      id: r.id, pid, name: name || '（未填姓名）', pname: names.get(pid) || pname || '', role: q['角色']?.select?.name || '',
      note: rt(q['備註']), time: fmtTime(q['申請時間']?.date?.start || r.created_time),
    };
  // 平台管理者看全部；製片人只看自己專案、製片人以外的申請
  }).filter((a) => isAdmin() || (rolesIn(a.pid).includes('製片人') && a.role !== '製片人'));
}

async function loadTasks() {
  const r = await api.tasks();
  // 總監的回應裡，不屬於自己角色的資料列欄位是空的（見 tools/make_blueprints.py 的 to_json）
  S.tasks = r.tasks.filter((t) => t && t.id).map(normalizeTask);
  // 專案資料庫已沒有專案狀態欄位（2026-10-31），只列出有任務的專案，任務多的排前面
  S.allProjects = r.projects.map(normalizeProject);
  const count = new Map();
  for (const t of S.tasks) if (t.projectId) count.set(t.projectId, (count.get(t.projectId) || 0) + 1);
  S.projects = S.allProjects.filter((p) => count.has(p.id))
    .sort((a, b) => count.get(b.id) - count.get(a.id));
  const asked = params.get('project');
  // 參與兩個以上專案時預設看全部專案（總工作量）；網址帶 project 時直接看那個專案
  S.projectId = (S.projects.find((p) => p.id === asked) || {}).id ?? 'all';
}

(async () => {
  S.roles = await (await fetch('roles.json', { cache: 'no-cache' })).json();
  S.roleOf = makeRoleMap(S.roles);
  if (IN_LIFF_HOST) {
    try {
      await liff.init({ liffId: CONFIG.liffId });
      if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); return; }
    } catch { blocked('無法開啟', '請從 LINE 開啟這個頁面。'); return; }
  } else {
    await loadScript('mock-data.js');
    await loadScript('mock.js');
    api = window.MOCK_API;
    $('#notice').textContent = `本機預覽：模擬資料（${window.MOCK_API.label}）。正式網址不會出現這段文字。`;
    $('#notice').hidden = false;
  }
  render();
  try {
    S.me = withAssign(await api.me());
    S.form.name = S.me.state === 'guest' ? '' : S.me.name;
    // 沒指定畫面時：團隊成員到我的工作，製片人、副製片、導演到團隊進度，其他人到加入團隊成員
    if (!S.view) S.view = homeView();
    if (S.view === 'task' && !S.detail.id) S.view = homeView();
    // 從 LINE 選單打開的這一頁是第 0 層
    history.replaceState({ ...snapshot(), d: 0 }, '', location.search);
    render();
    // ?v=task&id= 直接打開某一項工作（推播連結用；目前沒有推播，仍保留）
    await show(history.state);
  } catch (e) {
    if (!handleApiError(e)) blocked('暫時無法讀取', '請稍後再開一次。');
  }
})();

import { buildMine, buildTeam, filterLabel, filterTasks, makeRoleMap, normalizeProject, normalizeTask } from './stats.js';

// ===== 設定：LIFF ID 與 API 網址。正式網址（GitHub Pages）一律用真資料；本機預覽才載入 mock.js =====
// 所有畫面都送到 Make 情境「風雅存｜LIFF API」，欄位 a 是動作：
//   me 我的身分（順便校正選單）｜apply 申請加入｜tasks 任務與專案｜pending 待核准名單｜approve 核准｜reject 退回
//   task 任務明細與審核紀錄｜save 交件（改狀態、版本、連結、留言、上傳檔案）｜review 審核任務（核准或退回）
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
  apply: (f) => post({ a: 'apply', ...f }),
  tasks: () => post({ a: 'tasks' }),
  pending: () => post({ a: 'pending' }),
  approve: (id, role) => post({ a: 'approve', id, role }),
  reject: (id) => post({ a: 'reject', id }),
  task: (id) => post({ a: 'task', id }),
  save: (f) => post({ a: 'save', ...f }),
  review: (id, decision, comment) => post({ a: 'review', id, decision, comment }),
};

// ===== 狀態 =====
const params = new URLSearchParams(location.search);
const VIEWS = ['join', 'work', 'progress', 'approve', 'team', 'task'];
const S = {
  view: VIEWS.includes(params.get('v')) ? params.get('v') : null,
  roles: null, roleOf: null,
  me: null, tasks: null, projects: null, projectId: null, group: '全部',
  // 從進度頁點數字帶過來的篩選（見 stats.js 的 filterTasks）
  filter: params.get('f') || null,
  pending: null, form: { name: '', role: '', note: '' }, busy: false, editing: false,
  // 任務明細：id、從哪個畫面點進來（返回用）、讀回的資料、上傳中的檔案
  detail: { id: params.get('id'), from: null, data: null, file: null },
};
const isMember = () => S.me?.state === 'member';
const isManager = () => isMember() && S.roles.managers.includes(S.me.role);
const isApprover = () => isMember() && S.roles.approvers.includes(S.me.role);

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
const tiles = (items) => `<div class="tiles">${items.map(([label, n, tone, key]) =>
  pick(key, n, `<b>${n}</b><span>${label}</span>`, `tile ${n ? tone || '' : 'zero'}`)).join('')}</div>`;

function taskList(tasks, { showRole = false, today } = {}) {
  if (!tasks.length) return '<p class="empty">沒有項目</p>';
  return `<ul class="tasks">${tasks.map((t) => {
    const late = t.due && t.due < today && t.status !== '已核准';
    const meta = [showRole ? t.role : null, t.workflow || t.stage, t.version].filter(Boolean).join(' · ');
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
const TITLES = { join: '加入團隊成員', work: '我的工作', progress: '我的進度', approve: '核准團隊成員', team: '團隊進度', task: '工作項目' };

function render() {
  $('#title').textContent = TITLES[S.view] || '風雅存製作團隊';
  document.title = `${TITLES[S.view] || '風雅存'}｜風雅存製作團隊`;
  const badge = $('#badge');
  const st = S.me?.state;
  badge.hidden = !S.me || st === 'guest';
  badge.className = `badge ${st === 'pending' ? 'pending' : st === 'member' ? '' : 'muted'}`;
  badge.textContent = st === 'member' ? S.me.role : st === 'pending' ? '審核中' : st === 'rejected' ? '未通過' : st === 'disabled' ? '停用' : '';
  $('#bar').hidden = true;
  $('#tabs').hidden = true;
  $('#project').hidden = true;
  $('#foot').textContent = '';

  if (!S.me) { $('#app').innerHTML = '<p class="blocked">讀取中…</p>'; return; }
  if (st === 'disabled') return blocked('帳號已停用', '如有疑問請洽製作人。');
  if (S.view === 'join' || !isMember()) return renderJoin();
  if (S.view === 'approve') return isApprover() ? renderApprove() : blocked('沒有權限', '只有製作人與導演可以核准團隊成員。');
  if (S.view === 'team' && !isManager()) return blocked('沒有權限', '團隊進度只開放給製作人與導演。');
  if (S.view === 'task') return renderTask();
  if (!S.tasks) { $('#app').innerHTML = '<p class="blocked">讀取任務中…</p>'; return; }
  renderProjectSelect();
  if (S.view === 'team') return renderTeam();
  if (S.view === 'progress') return renderProgress();
  return renderWork();
}

function blocked(title, text) {
  $('#app').innerHTML = `<div class="blocked"><h2>${esc(title)}</h2><p>${esc(text)}</p></div>`;
}

function renderProjectSelect() {
  const sel = $('#project');
  sel.innerHTML = S.projects.map((p) => `<option value="${esc(p.id)}" ${p.id === S.projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  sel.hidden = S.projects.length < 2;
}

// ---- 加入團隊成員 ----
function renderJoin() {
  const m = S.me;
  if (m.state === 'member') {
    const links = isManager()
      ? [['team', '📊', '團隊進度', '各組進度與待審核'], ...(isApprover() ? [['approve', '✅', '核准團隊成員', '決定新成員的角色']] : [])]
      : [['work', '🗂', '我的工作', '本週到期、退回修改'], ['progress', '📈', '我的進度', '各工作的狀態']];
    $('#app').innerHTML = `<div class="status"><div class="big">🎬</div><h2>${esc(m.name)}，你已是團隊成員</h2>
      <p class="lead">角色：${esc(m.role)}。下方選單已換成團隊版。</p></div>
      <div class="links">${links.map(([v, ic, t, d]) => `<a class="link" href="?v=${v}"><span class="ic">${ic}</span><span><b>${t}</b><small>${d}</small></span></a>`).join('')}</div>`;
    return;
  }
  if (m.state === 'pending' && !S.editing) {
    $('#app').innerHTML = `<div class="status"><div class="big">⏳</div><h2>申請審核中</h2>
      <p class="lead">製作人核准後，下方選單會自動換成團隊版。</p></div>
      <section class="card"><h2>申請資料</h2><dl><dt>姓名</dt><dd>${esc(m.name)}</dd><dt>申請角色</dt><dd>${esc(m.applyRole)}</dd>
      <dt>說明</dt><dd>${esc(m.note) || '—'}</dd></dl></section>
      <button class="ghost" id="edit">修改申請資料</button>`;
    return;
  }
  const f = S.form;
  const roles = [...S.roles.creators, ...S.roles.managers];
  $('#app').innerHTML = `<h1>${m.state === 'pending' ? '修改申請' : '加入團隊成員'}</h1>
    <p class="lead">${m.state === 'rejected' ? '上次的申請沒有通過，可以修改後重新送出。' : '填寫後送出，由製作人核准並確認你的角色。'}</p>
    <section class="card">
      <label class="f">真實姓名 <b>*</b><input id="fName" value="${esc(f.name)}" autocomplete="name" maxlength="40"></label>
      <label class="f">你在團隊的角色 <b>*</b><select id="fRole"><option value="">請選擇</option>
        ${roles.map((r) => `<option ${r === f.role ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
      <label class="f">補充說明（選填）<textarea id="fNote" maxlength="300">${esc(f.note)}</textarea></label>
    </section>
    ${m.state === 'pending' ? '<button class="ghost" id="cancelEdit">← 不修改了</button>' : ''}`;
  $('#bar').hidden = false;
  $('#barIn').innerHTML = `<button class="primary" id="send" ${S.busy ? 'disabled' : ''}>${S.busy ? '送出中…' : '送出申請'}</button>`;
}

// ---- 我的工作 ----
function renderWork() {
  const v = buildMine({ tasks: S.tasks, role: S.me.role, roleOf: S.roleOf, projectId: S.projectId });
  const opts = { today: v.today };
  const html = [tiles([
    ['本週到期', v.summary.thisWeek, 'review', 'thisWeek'], ['已逾期', v.summary.overdue, 'warn', 'overdue'],
    ['退回修改', v.summary.counts['退回修改'], 'warn', 'status:退回修改'], ['待審核', v.summary.counts['待審核'], 'review', 'status:待審核'],
  ])];
  if (S.filter) {
    $('#app').innerHTML = [html[0], ...filteredView(v)].join('');
    setFoot(v);
    return;
  }
  if (v.lists.returned.length) html.push(listCard('退回修改・請重新提交', v.lists.returned, opts));
  if (v.lists.overdue.length) html.push(listCard('已逾期', v.lists.overdue, opts));
  html.push(listCard('本週到期', v.lists.thisWeek, opts));
  html.push(listCard('之後的工作', v.lists.later.filter((t) => t.status !== '退回修改'), opts));
  if (!v.summary.total) html.push('<p class="empty center">這個專案目前沒有指派給你的任務</p>');
  $('#app').innerHTML = html.join('');
  setFoot(v);
}

// ---- 我的進度 ----
function progressBody(v, { showRole = false } = {}) {
  const opts = { today: v.today, showRole };
  return [
    progressCard(v.group && v.group !== '全部' ? `${v.group}的進度` : showRole ? '團隊進度' : '我的進度', v.summary),
    tiles([
      ['執行中', v.summary.counts['執行創作中'], '', 'status:執行創作中'], ['待審核', v.summary.counts['待審核'], 'review', 'status:待審核'],
      ['退回修改', v.summary.counts['退回修改'], 'warn', 'status:退回修改'], ['已逾期', v.summary.overdue, 'warn', 'overdue'],
    ]),
    `<section class="card"><h2>各階段</h2>${stageRows(v.stages)}</section>`,
    ...v.statuses.map((g) => `<details class="card" ${g.status === '退回修改' || g.status === '待審核' ? 'open' : ''}>
      <summary><span class="chip" data-s="${g.status}">${g.status}</span> ${g.tasks.length} 項</summary>${taskList(g.tasks, opts)}</details>`),
  ];
}
function renderProgress() {
  const v = buildMine({ tasks: S.tasks, role: S.me.role, roleOf: S.roleOf, projectId: S.projectId });
  const toWork = `<a class="link" href="?v=work"><span class="ic">🗂</span><span><b>前往我的工作</b>
    <small>本週到期、退回修改；點工作項目可以交件</small></span></a>`;
  const body = progressBody(v);
  body.splice(1, 0, toWork);
  $('#app').innerHTML = v.summary.total ? body.join('') : '<p class="empty center">這個專案目前沒有指派給你的任務</p>';
  setFoot(v);
}

// ---- 團隊進度 ----
function renderTeam() {
  const groups = ['全部', ...S.roles.creators, ...S.roles.managers];
  $('#tabs').innerHTML = groups.map((g) => `<button data-group="${g}" aria-pressed="${g === S.group}">${g}</button>`).join('');
  $('#tabs').hidden = false;
  const v = buildTeam({ tasks: S.tasks, roles: S.roles, roleOf: S.roleOf, projectId: S.projectId, group: S.group });
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
        <p class="empty">請在 Notion 把「執行職掌」改成六個角色之一。</p>
        <ul class="tasks">${v.unmapped.map((t) => `<li><span class="t-name">${esc(t.name)}</span><span class="t-meta">目前：${esc(t.executor || '（空白）')}</span></li>`).join('')}</ul></details>`);
    }
  }
  $('#app').innerHTML = html.join('');
  setFoot(v);
}

// ---- 核准團隊成員 ----
function renderApprove() {
  if (!S.pending) { $('#app').innerHTML = '<p class="blocked">讀取申請中…</p>'; return; }
  const roles = [...S.roles.creators, ...S.roles.managers];
  if (!S.pending.length) {
    $('#app').innerHTML = '<div class="status"><div class="big">✅</div><h2>目前沒有待核准的申請</h2><p class="lead">有人申請時會出現在這裡。</p></div>';
    return;
  }
  $('#app').innerHTML = `<section class="card"><h2>待核准<span class="count">${S.pending.length}</span></h2>
    ${S.pending.map((p) => `<div class="applicant" data-id="${esc(p.id)}">
      <div><b>${esc(p.name)}</b> <span class="meta">LINE：${esc(p.line)}</span></div>
      <div class="meta">申請角色：${esc(p.applyRole || '—')}・${esc(p.time)}</div>
      ${p.note ? `<div class="meta">說明：${esc(p.note)}</div>` : ''}
      <div class="actions"><select aria-label="核准的角色">${roles.map((r) => `<option ${r === p.applyRole ? 'selected' : ''}>${r}</option>`).join('')}</select>
        <button class="btn ok" data-act="approve" ${p.busy ? 'disabled' : ''}>核准</button>
        <button class="btn no" data-act="reject" ${p.busy ? 'disabled' : ''}>退回</button></div>
    </div>`).join('')}</section>
    <p class="empty center">核准後，對方的 LINE 選單會自動換成對應角色的版本。</p>`;
}

// ---- 工作項目（明細、交件、審核） ----
const plain = (v) => (Array.isArray(v) ? v.map((x) => x.plain_text ?? x.text?.content ?? '').join('') : v?.name ?? (typeof v === 'string' ? v : ''));
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
    id: r.id, own: r.own === 'yes',
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
      ? `<p>你已送審 <b>${esc(t.version)}</b>（${fmtTime(t.submittedAt)}），等導演或製作人審核。</p>`
      : `<p><b>${esc(t.submitter)}</b> 在 ${fmtTime(t.submittedAt)} 送審 <b>${esc(t.version)}</b>${isApprover() ? '，請審核。' : '。'}</p>`);
    if (prevReturn) {
      parts.push(`<div class="compare">${quote(`上一版 ${esc(prevReturn.version)} 的審核意見・${esc(who(prevReturn.role, prevReturn.name))}`, prevReturn.note, 'warn')}
        ${quote(`這一版 ${esc(t.version)} 的說明・${esc(lastSubmit?.name || t.submitter)}`, lastSubmit?.note || '')}</div>`);
    } else if (lastSubmit?.note) {
      parts.push(quote(`送審說明・${esc(lastSubmit.name)}`, lastSubmit.note));
    }
  } else if (t.status === '退回修改') {
    parts.push(`<p><b>${esc(t.version)}</b> 被 ${esc(t.reviewer)} 退回（${fmtTime(t.reviewedAt)}）。</p>`, quote('審核意見', t.comment, 'warn'));
    if (t.own) parts.push(`<p class="muted">修改後，狀態選「待審核」儲存即可再送審，會記為 <b>${esc(nextVersion(t))}</b>。</p>`);
  } else if (t.status === '已核准') {
    parts.push(`<p><b>${esc(t.version)}</b> 已由 ${esc(t.reviewer)} 核准（${fmtTime(t.reviewedAt)}）。</p>`);
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
  const back = `<button class="ghost" id="back">← 返回${TITLES[d.from] || ''}</button>`;
  if (!d.data) { $('#app').innerHTML = `${back}<p class="blocked">讀取工作項目中…</p>`; return; }
  const t = d.data;
  const canEdit = t.own && t.status !== '已核准';
  const canReview = isApprover() && t.status === '待審核';
  const current = deliverables([...t.files.map((f) => [f.url, f.name]), [t.link, '雲端連結']]);
  const html = [back, `<section class="card">
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
      <p class="empty">送出後會記下你的身分（${esc(S.me.role)}）與姓名。</p></section>`);
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
      <label class="f">這次的說明（改了哪裡、想請導演或製作人看什麼）
        <textarea id="sNote" maxlength="1000" placeholder="${t.status === '退回修改' ? '例如：依意見把角色比例調高，背景改暖色' : '例如：先交三款造型，想確認方向'}"></textarea></label>
    </section>`);
    $('#bar').hidden = false;
    $('#barIn').innerHTML = `<button class="primary" id="saveTask" ${d.busy ? 'disabled' : ''}>${d.busy ? '儲存中…' : '儲存'}</button>`;
  } else if (t.own && t.status === '已核准') {
    html.push('<p class="empty center">這項工作已核准，不能再修改。需要修改請洽導演或製作人。</p>');
  }
  html.push(historyCard(t));
  $('#app').innerHTML = html.join('');
}

// 我的進度點數字 → 到我的工作看那些工作；我的工作、團隊進度點數字 → 原畫面篩選。key 空字串＝取消篩選
function applyFilter(key) {
  S.filter = key || null;
  if (S.filter && S.view === 'progress') S.view = 'work';
  setUrl({ v: S.view, f: S.filter });
  render(); scrollTo(0, 0);
}

// 換畫面時改網址（保留 as、project 等其他參數），重新整理會停在同一個畫面
function setUrl(kv) {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(kv)) if (v == null) q.delete(k); else q.set(k, v);
  history.replaceState(null, '', `?${q}`);
}

async function openTask(id, from = S.view) {
  S.detail = { id, from: from === 'task' ? S.detail.from : from, data: null, file: null, busy: false };
  S.view = 'task';
  setUrl({ v: 'task', id });
  render(); scrollTo(0, 0);
  try { S.detail.data = parseDetail(await api.task(id)); render(); }
  catch (x) {
    if (handleApiError(x)) return;
    blocked(x.code === 'not_found' ? '找不到這項工作' : '暫時無法讀取', x.code === 'not_found' ? '可能已被刪除或移到其他專案。' : '請稍後再試。');
  }
}

async function goBack() {
  S.view = S.detail.from || (isManager() ? 'team' : 'work');
  setUrl({ v: S.view, id: null });
  if (!S.tasks) await loadTasks();
  render(); scrollTo(0, 0);
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
    toast(f.status === '待審核' ? '已送審，導演與製作人可在團隊進度看到' : '已儲存');
    S.tasks = null;   // 回到清單時重新讀取
    await openTask(d.id, d.from);
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
    await openTask(d.id, d.from);
  } catch (x) {
    d.busy = false;
    if (handleApiError(x)) return;
    toast(x.code === 'bad_target' ? '這項工作已經不是待審核了' : '操作失敗，請再試一次');
    if (x.code === 'bad_target') return openTask(d.id, d.from);
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
  if (e.target.id === 'project') { S.projectId = e.target.value; render(); }
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
  const tab = e.target.closest('[data-group]');
  if (tab) { S.group = tab.dataset.group; render(); scrollTo(0, 0); return; }
  const fb = e.target.closest('[data-filter]');
  if (fb) return applyFilter(fb.dataset.filter);
  const item = e.target.closest('[data-task]');
  if (item && !e.target.closest('a')) return openTask(item.dataset.task);
  const t = e.target.closest('button');
  if (!t) return;
  if (t.id === 'edit') { S.editing = true; render(); return; }
  if (t.id === 'cancelEdit') { S.editing = false; render(); return; }
  if (t.id === 'send' && !S.busy) return sendApply();
  if (t.id === 'back') return goBack();
  if (t.id === 'saveTask' && !S.detail.busy) return saveTask();
  if (t.dataset.review && !S.detail.busy) return reviewTask(t.dataset.review);
  if (t.dataset.act) return decide(t.closest('.applicant'), t.dataset.act);
});
document.addEventListener('keydown', (e) => {
  const item = e.target.closest?.('[data-task]');
  if (item && e.key === 'Enter') openTask(item.dataset.task);
});

async function sendApply() {
  // 送出時直接讀畫面上的值：手機 LINE 的下拉選單不一定會觸發 change（2026-10-22 選了製作人卻送出編劇）
  S.form = { name: $('#fName').value, role: $('#fRole').value, note: $('#fNote').value };
  const f = { name: S.form.name.trim(), role: S.form.role, note: S.form.note.trim() };
  if (!f.name) return toast('請填寫真實姓名');
  if (!f.role) return toast('請選擇角色');
  S.busy = true; render();
  try {
    S.me = { ...(await api.apply(f)) };
    S.busy = false; S.editing = false; toast('已送出，等待製作人核准'); render(); scrollTo(0, 0);
  } catch (x) {
    S.busy = false;
    if (!handleApiError(x)) { toast('送出失敗，請再按一次'); render(); }
  }
}

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
    toast(x.code === 'bad_target' ? '這筆申請已經被處理過了' : '操作失敗，請再試一次');
    if (x.code === 'bad_target') S.pending = S.pending.filter((y) => y !== p);
  }
  render();
}

// ===== LIFF 與錯誤處理（沿用苗栗、名片模組的做法） =====
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

function parsePending(records) {
  const text = (v) => (Array.isArray(v) ? v.map((x) => x.plain_text ?? '').join('') : v?.name ?? '');
  return records.map((r) => {
    const p = r.properties_value || {};
    const start = p['申請時間']?.start;
    return {
      id: r.id, name: text(p['姓名']), line: text(p['LINE 顯示名稱']), applyRole: text(p['申請角色']), note: text(p['備註']),
      time: start ? new Date(start).toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '',
    };
  });
}

async function loadTasks() {
  const r = await api.tasks();
  S.projects = r.projects.map(normalizeProject).filter((p) => p.nature !== '標準範本')
    .sort((a, b) => (a.nature === '正式專案' ? 0 : 1) - (b.nature === '正式專案' ? 0 : 1));
  // 總監的回應裡，不屬於自己角色的資料列欄位是空的（見 tools/make_blueprints.py 的 to_json）
  S.tasks = r.tasks.filter((t) => t && t.id).map(normalizeTask);
  const asked = params.get('project');
  S.projectId = (S.projects.find((p) => p.id === asked) || S.projects[0] || {}).id ?? null;
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
    S.me = await api.me();
    if (S.me.state !== 'member') S.form = { name: S.me.state === 'guest' ? '' : S.me.name, role: S.me.applyRole || '', note: S.me.note || '' };
    // 沒指定畫面時：團隊成員到我的工作，製作人／導演到團隊進度，其他人到加入團隊成員
    if (!S.view) S.view = !isMember() ? 'join' : isManager() ? 'team' : 'work';
    render();
    if (!isMember() || S.view === 'join') return;
    if (S.view === 'approve') { if (isApprover()) { S.pending = parsePending((await api.pending()).members); render(); } return; }
    // ?v=task&id= 直接打開某一項工作（推播連結用；目前沒有推播，仍保留）
    if (S.view === 'task') return S.detail.id ? openTask(S.detail.id, isManager() ? 'team' : 'work') : goBack();
    await loadTasks();
    render();
  } catch (e) {
    if (!handleApiError(e)) blocked('暫時無法讀取', '請稍後再開一次。');
  }
})();

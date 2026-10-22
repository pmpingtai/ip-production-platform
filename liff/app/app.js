import { buildMine, buildTeam, makeRoleMap, normalizeProject, normalizeTask } from './stats.js';

// ===== 設定：LIFF ID 與 API 網址。正式網址（GitHub Pages）一律用真資料；本機預覽才載入 mock.js =====
// 所有畫面都送到 Make 情境「風雅存｜LIFF API」，欄位 a 是動作：
//   me 我的身分（順便校正選單）｜apply 申請加入｜tasks 任務與專案｜pending 待核准名單｜approve 核准｜reject 退回
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
};

// ===== 狀態 =====
const params = new URLSearchParams(location.search);
const VIEWS = ['join', 'work', 'progress', 'approve', 'team'];
const S = {
  view: VIEWS.includes(params.get('v')) ? params.get('v') : null,
  roles: null, roleOf: null,
  me: null, tasks: null, projects: null, projectId: null, group: '全部',
  pending: null, form: { name: '', role: '', note: '' }, busy: false, editing: false,
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
const legend = (counts) => `<div class="legend">${BAR_ORDER.map(
  (s) => `<span><i style="background:var(${STATUS_VAR[s]})"></i>${s} ${counts[s]}</span>`).join('')}</div>`;
const tiles = (items) => `<div class="tiles">${items.map(([label, n, tone]) =>
  `<div class="tile ${n ? tone || '' : 'zero'}"><b>${n}</b><span>${label}</span></div>`).join('')}</div>`;

function taskList(tasks, { showRole = false, today } = {}) {
  if (!tasks.length) return '<p class="empty">沒有項目</p>';
  return `<ul class="tasks">${tasks.map((t) => {
    const late = t.due && t.due < today && t.status !== '已核准';
    const meta = [showRole ? t.role : null, t.workflow || t.stage, t.version].filter(Boolean).join(' · ');
    return `<li><span class="t-name">${esc(t.name)}</span><span class="t-meta">${esc(meta)}</span>
      <span class="t-side"><span class="chip" data-s="${esc(t.status)}">${esc(t.status)}</span><br>
      <small class="${late ? 'due-late' : 'muted'}">${fmtDate(t.due)}</small></span></li>`;
  }).join('')}</ul>`;
}
const listCard = (title, tasks, opts) =>
  `<section class="card"><h2>${title}<span class="count">${tasks.length}</span></h2>${taskList(tasks, opts)}</section>`;
const progressCard = (title, s) => `<section class="card"><h2>${title}</h2>
  <div class="hero"><span class="pct">${s.percent}%</span><span class="sub">已核准 ${s.done} / 共 ${s.total} 項</span></div>
  ${statusBar(s.counts, s.total)}${legend(s.counts)}</section>`;
const stageRows = (stages) => `<div class="rows">${stages.map((g) => `<div>
  <div class="row-head"><span class="r-name">${esc(g.stage)}</span>
  <span class="r-nums">${g.done}/${g.total}${g.overdue ? ` · <span class="alert">逾期 ${g.overdue}</span>` : ''}</span></div>
  ${statusBar(g.counts, g.total, true)}</div>`).join('')}</div>`;

function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.append(t); setTimeout(() => t.remove(), 2400);
}

// ===== 畫面 =====
const TITLES = { join: '加入團隊成員', work: '我的工作', progress: '我的進度', approve: '核准團隊成員', team: '團隊進度' };

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

  if (!S.me) { $('#app').innerHTML = '<p class="blocked">讀取中…</p>'; return; }
  if (st === 'disabled') return blocked('帳號已停用', '如有疑問請洽製作人。');
  if (S.view === 'join' || !isMember()) return renderJoin();
  if (S.view === 'approve') return isApprover() ? renderApprove() : blocked('沒有權限', '只有製作人與導演可以核准團隊成員。');
  if (S.view === 'team' && !isManager()) return blocked('沒有權限', '團隊進度只開放給製作人與導演。');
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
    ['本週到期', v.summary.thisWeek, 'review'], ['已逾期', v.summary.overdue, 'warn'],
    ['退回修改', v.summary.counts['退回修改'], 'warn'], ['待審核', v.summary.counts['待審核'], 'review'],
  ])];
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
      ['執行中', v.summary.counts['執行創作中'], ''], ['待審核', v.summary.counts['待審核'], 'review'],
      ['退回修改', v.summary.counts['退回修改'], 'warn'], ['已逾期', v.summary.overdue, 'warn'],
    ]),
    `<section class="card"><h2>各階段</h2>${stageRows(v.stages)}</section>`,
    ...v.statuses.map((g) => `<details class="card" ${g.status === '退回修改' || g.status === '待審核' ? 'open' : ''}>
      <summary><span class="chip" data-s="${g.status}">${g.status}</span> ${g.tasks.length} 項</summary>${taskList(g.tasks, opts)}</details>`),
  ];
}
function renderProgress() {
  const v = buildMine({ tasks: S.tasks, role: S.me.role, roleOf: S.roleOf, projectId: S.projectId });
  $('#app').innerHTML = v.summary.total ? progressBody(v).join('') : '<p class="empty center">這個專案目前沒有指派給你的任務</p>';
  setFoot(v);
}

// ---- 團隊進度 ----
function renderTeam() {
  const groups = ['全部', ...S.roles.creators, ...S.roles.managers];
  $('#tabs').innerHTML = groups.map((g) => `<button data-group="${g}" aria-pressed="${g === S.group}">${g}</button>`).join('');
  $('#tabs').hidden = false;
  const v = buildTeam({ tasks: S.tasks, roles: S.roles, roleOf: S.roleOf, projectId: S.projectId, group: S.group });
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
    $('#app').innerHTML = '<div class="status"><div class="big">✅</div><h2>目前沒有待核准的申請</h2><p class="lead">有人申請時，你會收到 LINE 通知。</p></div>';
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

function setFoot(v) {
  $('#foot').textContent = `本週 ${fmtDate(v.week.start)}–${fmtDate(v.week.end)}・資料來自 Notion`;
}

// ===== 操作 =====
document.addEventListener('input', (e) => {
  if (e.target.id === 'fName') S.form.name = e.target.value;
  if (e.target.id === 'fNote') S.form.note = e.target.value;
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'fRole') S.form.role = e.target.value;
  if (e.target.id === 'project') { S.projectId = e.target.value; render(); }
});
document.addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-group]');
  if (tab) { S.group = tab.dataset.group; render(); scrollTo(0, 0); return; }
  const t = e.target.closest('button');
  if (!t) return;
  if (t.id === 'edit') { S.editing = true; render(); return; }
  if (t.id === 'cancelEdit') { S.editing = false; render(); return; }
  if (t.id === 'send' && !S.busy) return sendApply();
  if (t.dataset.act) return decide(t.closest('.applicant'), t.dataset.act);
});

async function sendApply() {
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
  S.tasks = r.tasks.map(normalizeTask);
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
    await loadTasks();
    render();
  } catch (e) {
    if (!handleApiError(e)) blocked('暫時無法讀取', '請稍後再開一次。');
  }
})();

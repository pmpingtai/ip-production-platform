// 任務統計：完成率、逾期、本週到期。瀏覽器與 node --test 共用，不依賴 DOM。
export const STATUSES = ['尚未開始', '執行創作中', '待審核', '退回修改', '已核准'];
export const DONE = '已核准';
export const STAGES = ['1 企劃階段', '2 前期製作', '3 中期製作', '4 後期製作', '5 交片與規格'];
export const UNMAPPED = '未對應';

// ---- Make 原樣轉出的 Notion properties_value → 一般值 ----
const text = (v) =>
  Array.isArray(v) ? v.map((x) => x.plain_text ?? x.text?.content ?? x.name ?? '').join('') : v?.name ?? (typeof v === 'string' ? v : '');
const plainId = (id) => String(id || '').replaceAll('-', '');

export function normalizeTask(record) {
  const p = record.properties_value || {};
  const rel = p['所屬專案'];
  return {
    id: plainId(record.id),
    seq: typeof p['序號'] === 'number' ? p['序號'] : null,
    name: text(p['任務名稱']) || '（未命名任務）',
    stage: text(p['階段']) || null,
    workflow: text(p['工作流程']) || null,
    executor: text(p['執行職掌']) || null,
    status: text(p['狀態']) || '尚未開始',
    due: (p['預計交付日']?.start || '').slice(0, 10) || null,
    version: text(p['版本號']) || null,
    projectId: Array.isArray(rel) && rel[0] ? plainId(rel[0].id ?? rel[0]) : null,
  };
}

export function normalizeProject(record) {
  const p = record.properties_value || {};
  return {
    id: plainId(record.id),
    name: text(p['專案名稱']) || '（未命名專案）',
    nature: text(p['專案性質']) || null,
    status: text(p['專案狀態']) || null,
  };
}

// ---- 角色 ----
export function makeRoleMap(roles) {
  const m = new Map();
  for (const [role, names] of Object.entries(roles.aliases)) for (const n of names) m.set(n, role);
  return (executor) => (executor && m.get(executor)) || UNMAPPED;
}

// ---- 日期（台北時間） ----
export function taipeiToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(now);
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 本週＝週一到週日
export function weekRange(today) {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const start = addDays(today, dow === 0 ? -6 : 1 - dow);
  return { start, end: addDays(start, 6) };
}

// ---- 統計 ----
const bySeq = (a, b) => (a.seq ?? 999) - (b.seq ?? 999);
const byDue = (a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || bySeq(a, b);

export function summarize(tasks, today, week) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  let overdue = 0;
  let thisWeek = 0;
  let noDue = 0;
  for (const t of tasks) {
    if (t.status in counts) counts[t.status] += 1;
    if (t.status === DONE) continue;
    if (!t.due) noDue += 1;
    else if (t.due < today) overdue += 1;
    else if (t.due <= week.end) thisWeek += 1;
  }
  const total = tasks.length;
  return { total, counts, done: counts[DONE], percent: total ? Math.round((counts[DONE] / total) * 100) : 0, overdue, thisWeek, noDue };
}

function lists(tasks, today, week) {
  const open = tasks.filter((t) => t.status !== DONE);
  return {
    returned: tasks.filter((t) => t.status === '退回修改').sort(byDue),
    pendingReview: tasks.filter((t) => t.status === '待審核').sort(byDue),
    overdue: open.filter((t) => t.due && t.due < today).sort(byDue),
    // 本週已過去的日子算逾期，所以本週清單從今天開始
    thisWeek: open.filter((t) => t.due && t.due >= today && t.due <= week.end).sort(byDue),
    later: open.filter((t) => !t.due || t.due > week.end).sort(byDue),
  };
}

function byStage(tasks, today, week) {
  return STAGES.map((stage) => {
    const inStage = tasks.filter((t) => t.stage === stage).sort(bySeq);
    return { stage, ...summarize(inStage, today, week), tasks: inStage };
  }).filter((g) => g.total > 0);
}

function byStatus(tasks) {
  return STATUSES.map((status) => ({ status, tasks: tasks.filter((t) => t.status === status).sort(byDue) })).filter(
    (g) => g.tasks.length,
  );
}

// 從進度頁的數字點進來的篩選：status:<狀態>、stage:<階段>、overdue、thisWeek
export function filterLabel(key) {
  if (!key) return '';
  const [kind, value] = key.split(':');
  return { status: value, stage: value, overdue: '已逾期', thisWeek: '本週到期' }[kind] || '';
}

export function filterTasks(tasks, key, today = taipeiToday()) {
  const [kind, value] = String(key || '').split(':');
  const week = weekRange(today);
  const open = (t) => t.status !== DONE;
  const test = {
    status: (t) => t.status === value,
    stage: (t) => t.stage === value,
    overdue: (t) => open(t) && t.due && t.due < today,
    thisWeek: (t) => open(t) && t.due && t.due >= today && t.due <= week.end,
  }[kind];
  return test ? tasks.filter(test).sort(byDue) : [];
}

// 我的工作／我的進度：只算執行職掌對應到 role 的任務
export function buildMine({ tasks, role, roleOf, projectId, today = taipeiToday() }) {
  const week = weekRange(today);
  const mine = tasks.filter((t) => t.projectId === projectId && roleOf(t.executor) === role).map((t) => ({ ...t, role }));
  return {
    today,
    week,
    tasks: mine,
    summary: summarize(mine, today, week),
    lists: lists(mine, today, week),
    stages: byStage(mine, today, week),
    statuses: byStatus(mine),
  };
}

// 團隊進度：group 是「全部」或某個角色；roles 用來列出各角色的列
export function buildTeam({ tasks, roles, roleOf, projectId, group = '全部', today = taipeiToday() }) {
  const week = weekRange(today);
  const scoped = tasks.filter((t) => t.projectId === projectId).map((t) => ({ ...t, role: roleOf(t.executor) }));
  const shown = group === '全部' ? scoped : scoped.filter((t) => t.role === group);
  const roleRows = [...roles.creators, ...roles.managers, UNMAPPED]
    .map((r) => ({ role: r, ...summarize(scoped.filter((t) => t.role === r), today, week) }))
    .filter((row) => row.total > 0 || row.role !== UNMAPPED);
  return {
    today,
    week,
    group,
    tasks: shown,
    summary: summarize(shown, today, week),
    lists: lists(shown, today, week),
    stages: byStage(shown, today, week),
    statuses: byStatus(shown),
    roles: roleRows,
    unmapped: scoped.filter((t) => t.role === UNMAPPED).sort(bySeq),
  };
}

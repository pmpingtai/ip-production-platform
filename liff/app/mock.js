// 本機預覽用的模擬後端（正式網址 github.io 不會載入）。網址加 ?as= 切換身分：
//   guest 訪客｜pending 審核中｜rejected 未通過
//   角色（在示範專案 A）：製片人、副製片、導演、編劇、藝術總監、動畫總監、聲音總監；兼多個角色用 + 連接，例如 ?as=製片人+導演
//   角色後面加 @B 表示在示範專案 B，例如 ?as=聲音總監+導演@B；加 admin 是平台管理者，例如 ?as=admin+聲音總監
// 任務清單來自 mock-data.js 的 Notion 快照；狀態與日期換成虛構值，讓每種狀態都看得到。
(() => {
  const as = new URLSearchParams(location.search).get('as') || '製片人';
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const PATTERN = [['已核准', -10, 'V2'], ['已核准', -4, 'V1'], ['待審核', -1, 'V1'], ['執行創作中', 2, null],
    ['退回修改', 1, 'V2'], ['尚未開始', 9, null], ['尚未開始', -3, null], ['執行創作中', 5, null]];

  const rt = (s) => (s ? [{ plain_text: s }] : []);
  const sel = (s) => (s ? { name: s } : null);
  const plain = (id) => String(id).replace(/-/g, '');
  const { projects, columns, rows } = window.MOCK_DATA;
  const tasks = rows.map((row, i) => {
    const t = Object.fromEntries(columns.map((c, j) => [c, row[j]]));
    const [status, offset, version] = PATTERN[i % PATTERN.length];
    return {
      id: `mock-task-${i + 1}`,
      properties_value: {
        任務名稱: rt(t.name), 序號: t.seq, 階段: sel(t.stage), 工作流程: sel(t.workflow), 執行職掌: sel(t.executor),
        狀態: sel(status), 預計交付日: { start: addDays(today, offset) }, 版本號: sel(version), 所屬專案: [{ id: t.projectId }],
      },
    };
  });
  // 和正式環境相同的格式：多專案任務總管理（名稱、標籤）
  const projectRecords = projects.map((p) => ({ id: p.id, properties_value: { 名稱: rt(p.name), 標籤: [{ name: '進行中' }] } }));
  // 示範專案 C：剛在多專案任務總管理建好、還沒有任務，平台管理者可以在團隊進度按「建立專案工作」
  const PC_ID = 'demo0000000000000000000000000003';
  projectRecords.push({ id: PC_ID, properties_value: { 名稱: rt('示範新專案 C'), 標籤: [{ name: '進行中' }] } });
  const PA = plain(projects[0].id), PB = plain(projects[1].id);

  // 角色對應（同 roles.json）：頁面載入時已讀過，這裡再讀一次給模擬後端用
  let roleOf = () => '';
  const ready = fetch('roles.json').then((r) => r.json()).then((cfg) => {
    const m = new Map();
    for (const [role, names] of Object.entries(cfg.aliases)) for (const n of names) m.set(n, role);
    roleOf = (x) => m.get(x) || '';
    CREATORS = cfg.creators;
  });
  let CREATORS = [];

  // 我的專案角色：狀態:專案:角色
  const ALL = ['製片人', '副製片', '導演', '編劇', '藝術總監', '動畫總監', '聲音總監'];
  const tokens = as.split('+').map((x) => x.split('@'));
  const asRoles = tokens.filter(([r]) => ALL.includes(r)).map(([r]) => r);
  const admin = tokens.some(([r]) => r === 'admin');
  let assign = tokens.filter(([r]) => ALL.includes(r)).map(([r, p]) => ({ status: '已核准', pid: p === 'B' ? PB : PA, role: r }));
  if (as === 'pending') assign = [{ status: '審核中', pid: PA, role: '藝術總監' }];
  if (as === 'rejected') assign = [{ status: '已退回', pid: PA, role: '編劇' }];
  let name = admin ? '示範平台管理者' : asRoles.length ? `示範${asRoles.join('')}` : as === 'pending' ? '王小美' : as === 'rejected' ? '李大同' : '';
  const keys = () => `|${assign.map((a) => `${a.status}:${a.pid}:${a.role}`).join('|')}|`;
  const mine = (pid) => assign.filter((a) => a.status === '已核准' && a.pid === plain(pid)).map((a) => a.role);
  const me = () => {
    const roles = assign.filter((a) => a.status === '已核准').map((a) => a.role);
    const state = roles.length || admin ? 'member' : assign.some((a) => a.status === '審核中') ? 'pending'
      : assign.some((a) => a.status === '已退回') ? 'rejected' : 'guest';
    return { ok: true, state, name, line: name || '訪客', keys: keys(), roles: roles.join(','), admin: admin ? 'yes' : 'no' };
  };

  let apps = [
    { name: '陳小雲', role: '聲音總監', note: '主題曲與配樂', time: `${today}T09:20:00+08:00` },
    { name: '林志明', role: '動畫總監', note: '', time: `${addDays(today, -1)}T18:05:00+08:00` },
    { name: '張大華', role: '製片人', note: '想擔任新專案的製片人', time: `${addDays(today, -1)}T10:00:00+08:00` },
  ].map((a, i) => ({
    id: `app-${i + 1}`, created_time: a.time,
    properties: {
      紀錄: { title: rt(`${a.name}｜${projects[0].name}｜${a.role}`) }, 專案: { relation: [{ id: projects[0].id }] },
      角色: { select: sel(a.role) }, 備註: { rich_text: rt(a.note) }, 申請時間: { date: { start: a.time } },
    },
  }));

  const MANAGERS = ['製片人', '副製片', '導演'];
  const taskInfo = (t) => {
    const p = t.properties_value;
    const pid = plain(p.所屬專案?.[0]?.id || '');
    const role = roleOf(p.執行職掌?.name);
    const reviewer = CREATORS.includes(role) ? '導演' : '製片人';
    const my = mine(pid);
    return { role, reviewer, own: my.includes(role), canReview: my.includes(reviewer), mgr: admin || my.some((r) => MANAGERS.includes(r)) };
  };

  window.MOCK_API = {
    label: as.includes('+') || admin || asRoles.length ? as.replace(/\+/g, '＋') : { guest: '訪客', pending: '審核中', rejected: '未通過' }[as] || as,
    async me() { await ready; await wait(200); return me(); },
    async projects() { await wait(200); return { ok: true, projects: projectRecords }; },
    async apply(f) {
      await wait(500);
      // 示範：專案 A 的製片人已經有人（同正式後端：一個角色一個人）
      if (plain(f.project) === PA && f.role === '製片人' && !assign.some((a) => a.pid === PA && a.role === '製片人')) throw err('taken');
      name = f.name;
      assign.push({ status: '審核中', pid: plain(f.project), role: f.role });
      return { ok: true };
    },
    async tasks() {
      await ready; await wait(300);
      // 和正式後端相同：製片人、副製片、導演拿到該專案全部任務；其他角色只拿到自己職掌的任務
      const visible = tasks.filter((t) => { const i = taskInfo(t); return i.own || i.mgr; });
      return { ok: true, tasks: visible, projects: projectRecords };
    },
    // 專案雲端資料夾：示範專案 A 的七個分類（「法律相關文件」故意沒填連結，看沒有連結時的樣子）
    async links() {
      await ready; await wait(300);
      const names = ['企劃書資料庫', '劇本資料庫', '美術資料庫', '動畫資料庫', '聲音資料庫', '最終交付檔案', '法律相關文件'];
      const links = names.map((n, i) => ({
        id: `mock-ip-${i + 1}`,
        properties_value: { 名稱: rt(n), 雲端連結: i < 6 ? `https://drive.google.com/drive/folders/mock-${i + 1}` : null,
          專案: [{ id: projects[0].id }], 排序: i + 1 },
      })).filter((l) => mine(l.properties_value.專案[0].id).length);
      return { ok: true, links };
    },
    // 專案進度推播：設定只存在記憶體（重新整理就還原），現在推一次只回應成功
    async push_get(pid) {
      await wait(300);
      if (!['製片人', '導演'].some((r) => mine(pid).includes(r))) throw err('forbidden');
      const s = pushSet[plain(pid)] || { daily: false, hour: 9, instant: false };
      return { ok: true, push: [{ properties: {
        每日推播: { checkbox: s.daily }, 推播時間: { number: s.hour }, 即刻推播: { checkbox: s.instant },
        設定人: { rich_text: rt(s.by) }, 設定時間: { date: s.at ? { start: s.at } : null }, 上次推播時間: { date: s.last ? { start: s.last } : null },
      } }] };
    },
    async push_set(f) {
      await wait(400);
      if (!['製片人', '導演'].some((r) => mine(f.pid).includes(r))) throw err('forbidden');
      pushSet[plain(f.pid)] = { ...pushSet[plain(f.pid)], daily: f.daily === '1', hour: Number(f.hour), instant: f.instant === '1',
        by: name, at: new Date().toISOString() };
      return { ok: true };
    },
    async push_now(pid) {
      await wait(400);
      if (!['製片人', '導演'].some((r) => mine(pid).includes(r))) throw err('forbidden');
      (pushSet[plain(pid)] ||= { daily: false, hour: 9, instant: false }).last = new Date().toISOString();
      return { ok: true };
    },
    async setup(pid) {
      await wait(400);
      if (!admin) throw err('forbidden');
      if (tasks.some((t) => plain(t.properties_value.所屬專案[0].id) === plain(pid))) throw err('exists');
      // 正式環境約一分鐘後才建好；模擬時直接複製示範專案 A 的任務
      tasks.push(...tasks.filter((t) => plain(t.properties_value.所屬專案[0].id) === PA).map((t, i) => ({
        id: `mock-setup-${i + 1}`, properties_value: { ...t.properties_value, 狀態: sel('尚未開始'), 預計交付日: null, 版本號: null, 所屬專案: [{ id: pid }] },
      })));
      return { ok: true };
    },
    async pending() { await wait(300); return { ok: true, apps }; },
    async approve(id, role) {
      await wait(400);
      if (role === '製片人' && !admin) throw err('bad_target');   // 製片人的申請只有平台管理者能核准
      apps = apps.filter((p) => p.id !== id); return { ok: true };
    },
    async reject(id) { await wait(400); apps = apps.filter((p) => p.id !== id); return { ok: true }; },

    // 任務明細、交件、審核：只改記憶體裡的資料，重新整理就還原
    async task(id) {
      await ready; await wait(300);
      const t = find(id);
      const i = taskInfo(t);
      if (!i.own && !i.mgr && !i.canReview) throw err('forbidden');
      return { ok: true, id, own: i.own ? 'yes' : 'no', canReview: i.canReview ? 'yes' : 'no', reviewer: i.reviewer, role: i.role,
        task: t.properties_value, logs: (logs[id] || []).slice().reverse() };
    },
    async save(f) {
      await wait(f.file ? 1200 : 500);
      const t = find(f.id), p = t.properties_value;
      if (!taskInfo(t).own || p.狀態?.name === '已核准') throw err('locked');
      const fileUrl = f.file ? `https://drive.google.com/file/d/mock-file-${Date.now()}/view` : '';
      // 版本號由系統決定（同 Make）：第一次送審沿用或 V1，之後每次送審加一
      let version = p.版本號?.name || '';
      if (f.status === '待審核') {
        const n = Number((version || 'V0').slice(1));
        version = !p.提交時間 || p.狀態?.name === '待審核' ? version || 'V1' : `V${n + 1}`;
      }
      Object.assign(p, { 狀態: sel(f.status), 版本號: sel(version), 交付雲端連結: f.link, ...(f.note ? { 執行者留言: rt(f.note) } : {}) });
      if (fileUrl) p.交付檔案上傳 = [{ name: `${p.序號 || 'task'}.${f.ext}`, url: fileUrl }];
      if (f.status === '待審核') Object.assign(p, { 提交人: rt(name), 提交時間: { start: new Date().toISOString() } });
      log(f.id, f.status === '待審核' ? '送審' : '改狀態', f.status, version, f.note, f.link, fileUrl, taskInfo(t).role);
      return { ok: true };
    },
    async review(id, decision, comment) {
      await wait(500);
      const t = find(id), p = t.properties_value, i = taskInfo(t);
      if (!i.canReview) throw err('forbidden');
      if (p.狀態?.name !== '待審核') throw err('bad_target');
      const status = decision === 'approve' ? '已核准' : '退回修改';
      Object.assign(p, { 狀態: sel(status), 審核意見: rt(comment), 審核身分: sel(i.reviewer), 審核人: rt(name), 審核日期: { start: new Date().toISOString() } });
      log(id, decision === 'approve' ? '核准' : '退回', status, p.版本號?.name, comment, '', '', i.reviewer);
      return { ok: true };
    },
  };

  const err = (code) => Object.assign(new Error(code), { code });
  // stats.js 會把 Notion id 的連字號拿掉
  const find = (id) => { const t = tasks.find((x) => plain(x.id) === plain(id)); if (!t) throw err('not_found'); return t; };
  const logs = {};
  const pushSet = {};
  // 和 Notion 查詢結果同格式（properties 原始結構），讓頁面的解析和正式環境一樣
  const log = (id, action, status, version, note, link, file, role) => (logs[id] ||= []).push({
    created_time: new Date().toISOString(),
    properties: {
      動作: { select: sel(action) }, 狀態: { select: sel(status) }, 版本號: { select: sel(version) }, 身分: { select: sel(role) },
      姓名: { rich_text: rt(name) }, 時間: { date: { start: new Date().toISOString() } }, 意見: { rich_text: rt(note) },
      雲端連結: { url: link || null }, 上傳檔案: { url: file || null },
    },
  });
})();

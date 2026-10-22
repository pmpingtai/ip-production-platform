// 本機預覽用的模擬後端（正式網址 github.io 不會載入）。網址加 ?as= 切換身分：
//   guest 訪客｜pending 審核中｜rejected 未通過｜編劇、藝術總監、作畫監督、聲音總監、導演、製作人
// 任務清單來自 mock-data.js 的 Notion 快照；狀態與日期換成虛構值，讓每種狀態都看得到。
(() => {
  const as = new URLSearchParams(location.search).get('as') || '製作人';
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const PATTERN = [['已核准', -10, 'V2'], ['已核准', -4, 'V1'], ['待審核', -1, 'V1'], ['執行創作中', 2, null],
    ['退回修改', 1, 'V2'], ['尚未開始', 9, null], ['尚未開始', -3, null], ['執行創作中', 5, null]];

  const rt = (s) => (s ? [{ plain_text: s }] : []);
  const sel = (s) => (s ? { name: s } : null);
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
  const projectRecords = projects.map((p) => ({
    id: p.id, properties_value: { 專案名稱: rt(p.name), 專案性質: sel(p.nature), 專案狀態: sel(p.status) },
  }));

  const ROLES = ['編劇', '藝術總監', '作畫監督', '聲音總監', '導演', '製作人'];
  let me = ROLES.includes(as)
    ? { ok: true, state: 'member', role: as, name: `示範${as}`, line: `${as}的 LINE` }
    : as === 'pending' ? { ok: true, state: 'pending', role: '', applyRole: '藝術總監', name: '王小美', note: '負責場景與道具', line: 'Mei' }
    : as === 'rejected' ? { ok: true, state: 'rejected', role: '', applyRole: '編劇', name: '李大同', note: '', line: 'Tung' }
    : { ok: true, state: 'guest', role: '', name: '', line: '訪客' };

  let pending = [
    { id: 'm1', properties_value: { 姓名: rt('陳小雲'), 'LINE 顯示名稱': rt('Cloud'), 申請角色: sel('聲音總監'), 備註: rt('主題曲與配樂'), 申請時間: { start: `${today}T09:20:00+08:00` } } },
    { id: 'm2', properties_value: { 姓名: rt('林志明'), 'LINE 顯示名稱': rt('Ming'), 申請角色: sel('作畫監督'), 備註: rt(''), 申請時間: { start: `${addDays(today, -1)}T18:05:00+08:00` } } },
  ];

  window.MOCK_API = {
    label: ROLES.includes(as) ? as : { guest: '訪客', pending: '審核中', rejected: '未通過' }[as] || as,
    async me() { await wait(200); return me; },
    async apply(f) { await wait(500); me = { ...me, state: 'pending', name: f.name, applyRole: f.role, note: f.note }; return me; },
    async tasks() {
      await wait(300);
      // 和正式後端相同：總監只拿到自己的任務，導演與製作人拿到全部
      const alias = { 藝術總監: ['藝術總監', '場景設計師', '道具設計師'], 聲音總監: ['聲音總監', '音樂製作人', '詞曲創作者'] };
      const mine = (r) => (alias[me.role] || [me.role]).includes(r.properties_value.執行職掌?.name);
      const managers = ['導演', '製作人'];
      return { ok: true, tasks: managers.includes(me.role) ? tasks : tasks.filter(mine), projects: projectRecords };
    },
    async pending() { await wait(300); return { ok: true, members: pending }; },
    async approve(id) { await wait(400); pending = pending.filter((p) => p.id !== id); return { ok: true }; },
    async reject(id) { await wait(400); pending = pending.filter((p) => p.id !== id); return { ok: true }; },

    // 任務明細、交件、審核：只改記憶體裡的資料，重新整理就還原
    async task(id) {
      await wait(300);
      const t = find(id);
      const own = (ownRoles()).includes(t.properties_value.執行職掌?.name);
      if (!own && !managers.includes(me.role)) throw err('forbidden');
      return { ok: true, id, own: own ? 'yes' : 'no', task: t.properties_value, logs: (logs[id] || []).slice().reverse() };
    },
    async save(f) {
      await wait(f.file ? 1200 : 500);
      const t = find(f.id), p = t.properties_value;
      if (!ownRoles().includes(p.執行職掌?.name) || p.狀態?.name === '已核准') throw err('locked');
      const fileUrl = f.file ? `https://drive.google.com/file/d/mock-${Date.now()}/view` : '';
      Object.assign(p, { 狀態: sel(f.status), 版本號: sel(f.version), 交付雲端連結: f.link, 執行者留言: rt(f.note) });
      if (fileUrl) p.交付檔案上傳 = [{ name: `${p.序號 || 'task'}.${f.ext}`, url: fileUrl }];
      if (f.status === '待審核') Object.assign(p, { 提交人: rt(me.name), 提交時間: { start: new Date().toISOString() } });
      log(f.id, f.status === '待審核' ? '送審' : '改狀態', f.status, f.version, f.note, f.link, fileUrl);
      return { ok: true };
    },
    async review(id, decision, comment) {
      await wait(500);
      const p = find(id).properties_value;
      if (!managers.includes(me.role)) throw err('forbidden');
      if (p.狀態?.name !== '待審核') throw err('bad_target');
      const status = decision === 'approve' ? '已核准' : '退回修改';
      Object.assign(p, { 狀態: sel(status), 審核意見: rt(comment), 審核身分: sel(me.role), 審核人: rt(me.name), 審核日期: { start: new Date().toISOString() } });
      log(id, decision === 'approve' ? '核准' : '退回', status, p.版本號?.name, comment, '', '');
      return { ok: true };
    },
  };

  const managers = ['導演', '製作人'];
  const ALIAS = { 藝術總監: ['藝術總監', '場景設計師', '道具設計師'], 聲音總監: ['聲音總監', '音樂製作人', '詞曲創作者'] };
  const ownRoles = () => ALIAS[me.role] || [me.role];
  const err = (code) => Object.assign(new Error(code), { code });
  // stats.js 會把 Notion id 的連字號拿掉
  const find = (id) => { const t = tasks.find((x) => x.id.replace(/-/g, '') === id.replace(/-/g, '')); if (!t) throw err('not_found'); return t; };
  const logs = {};
  // 和 Notion 查詢結果同格式（properties 原始結構），讓頁面的解析和正式環境一樣
  const log = (id, action, status, version, note, link, file) => (logs[id] ||= []).push({
    created_time: new Date().toISOString(),
    properties: {
      動作: { select: sel(action) }, 狀態: { select: sel(status) }, 版本號: { select: sel(version) }, 身分: { select: sel(me.role) },
      姓名: { rich_text: rt(me.name) }, 時間: { date: { start: new Date().toISOString() } }, 意見: { rich_text: rt(note) },
      雲端連結: { url: link || null }, 上傳檔案: { url: file || null },
    },
  });
})();

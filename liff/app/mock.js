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
  };
})();

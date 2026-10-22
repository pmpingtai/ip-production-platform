import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildMine, buildTeam, makeRoleMap, normalizeTask, weekRange, UNMAPPED } from '../liff/app/stats.js';

const roles = JSON.parse(readFileSync(new URL('../liff/app/roles.json', import.meta.url), 'utf8'));
const roleOf = makeRoleMap(roles);
const P = 'p1';
const task = (over) => ({ projectId: P, seq: 1, name: 't', stage: '2 前期製作', status: '尚未開始', due: null, ...over });

test('本週為週一到週日', () => {
  assert.deepEqual(weekRange('2026-10-21'), { start: '2026-10-19', end: '2026-10-25' });
  assert.deepEqual(weekRange('2026-10-25'), { start: '2026-10-19', end: '2026-10-25' });
});

test('舊職稱對應到六個角色，未知值歸為未對應', () => {
  assert.equal(roleOf('場景設計師'), '藝術總監');
  assert.equal(roleOf('音樂製作人'), '聲音總監');
  assert.equal(roleOf('監製'), UNMAPPED);
  assert.equal(roleOf(null), UNMAPPED);
});

test('Make 轉出的 properties_value 轉成任務', () => {
  const t = normalizeTask({
    id: '00000000-0000-4000-8000-000000000001',
    properties_value: {
      任務名稱: [{ plain_text: '道具概念草圖' }], 序號: 32, 階段: { name: '2 前期製作' }, 執行職掌: { name: '藝術總監' },
      狀態: { name: '待審核' }, 預計交付日: { start: '2026-10-28', end: null }, 所屬專案: [{ id: 'aa-bb' }],
    },
  });
  assert.deepEqual([t.id, t.name, t.status, t.due, t.projectId, t.version], ['00000000000040008000000000000001', '道具概念草圖', '待審核', '2026-10-28', 'aabb', null]);
});

test('我的工作：只算自己的任務，逾期與本週不重複', () => {
  const tasks = [
    task({ executor: '藝術總監', due: '2026-10-20' }),
    task({ executor: '場景設計師', due: '2026-10-23' }),
    task({ executor: '藝術總監', due: '2026-10-23', status: '已核准' }),
    task({ executor: '作畫監督', due: '2026-10-22' }),
    task({ executor: '藝術總監', projectId: 'other' }),
  ];
  const v = buildMine({ tasks, role: '藝術總監', roleOf, projectId: P, today: '2026-10-21' });
  assert.equal(v.summary.total, 3);
  assert.equal(v.summary.overdue, 1);
  assert.equal(v.summary.thisWeek, 1);
  assert.equal(v.lists.thisWeek.length, 1);
  assert.equal(v.summary.percent, 33);
});

test('團隊進度：可切換組別，並列出未對應的任務', () => {
  const tasks = [
    task({ executor: '藝術總監', status: '待審核' }),
    task({ executor: '編劇' }),
    task({ executor: '監製' }),
  ];
  const all = buildTeam({ tasks, roles, roleOf, projectId: P, today: '2026-10-21' });
  assert.equal(all.summary.total, 3);
  assert.equal(all.unmapped.length, 1);
  assert.ok(all.roles.some((r) => r.role === UNMAPPED && r.total === 1));
  const art = buildTeam({ tasks, roles, roleOf, projectId: P, group: '藝術總監', today: '2026-10-21' });
  assert.equal(art.summary.total, 1);
  assert.equal(art.lists.pendingReview.length, 1);
});

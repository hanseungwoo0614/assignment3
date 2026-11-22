// 보고서 증거용 시나리오 실행 스크립트 (직접 작성).
// 임시 DB에서 서버를 띄워 거부·정원·대기 순서·롤백 상황의 HTTP 응답과 DB 전후 상태를 출력합니다.
// 실행: node docs/evidence/scenarios.js            (전체)
//       node docs/evidence/scenarios.js 4          (시나리오 4만, 캡처용)
//       node docs/evidence/scenarios.js > docs/evidence/scenarios-output.txt
// 토큰 등 비밀 값은 출력하지 않습니다.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb } from '../../src/db.js';
import { createApp } from '../../src/app.js';

const dir = mkdtempSync(join(tmpdir(), 'assignment2-evidence-'));
const db = openDb(join(dir, 'evidence.sqlite'));
const server = createApp({ db, secret: randomBytes(48).toString('hex') }).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, path, token, body) {
  const r = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, data: await r.json() };
}
const tokens = {};
for (const u of ['alice', 'bob', 'charlie', 'manager1', 'manager2']) tokens[u] = (await call('POST', '/api/auth/login', null, { username: u, password: 'Classroom123!' })).data.accessToken;
const apps = () => db.prepare('SELECT id,event_id,user_id,status,created_at FROM applications ORDER BY id').all();
const hist = () => db.prepare('SELECT id,application_id,actor_id,action,from_status,to_status,reason,cause_history_id FROM application_history ORDER BY id').all();
const reset = () => db.exec('DELETE FROM application_history; DELETE FROM applications; DELETE FROM sqlite_sequence');
const only = process.argv[2];
let current = '';
const log = s => {
  const m = s.match(/# 시나리오 (\S+):/);
  if (m) current = m[1];
  if (!only || current === only || current.startsWith(only + '-')) console.log(s);
};
const show = (title, obj) => log(`\n## ${title}\n` + (Array.isArray(obj) ? obj.map(o => '  ' + JSON.stringify(o)).join('\n') : JSON.stringify(obj)));
const brief = r => ({ status: r.status, code: r.data.code, body: r.data.code ? undefined : r.data });

try {
  // 1) 거부 사례: 학생 대기 취소 후 오래된 운영자 화면에서 승인 (R3·R8)
  log('# 시나리오 1: 대기 취소 후 오래된 화면의 승인 (T10·U02)');
  const a1 = (await call('POST', '/api/events/1/applications', tokens.alice, {})).data;
  await call('POST', `/api/applications/${a1.id}/cancel`, tokens.alice, {});
  show('변경 전 applications', apps()); show('변경 전 history', hist());
  show('manager1 POST /api/applications/' + a1.id + '/approve', brief(await call('POST', `/api/applications/${a1.id}/approve`, tokens.manager1, {})));
  show('변경 후 applications', apps()); show('변경 후 history 건수', hist().length);

  // 2) 정원 초과 (R4)
  reset();
  log('\n# 시나리오 2: 정원 2명 행사에서 세 번째 승인 (T13)');
  const ids = [];
  for (const u of ['alice', 'bob', 'charlie']) ids.push((await call('POST', '/api/events/1/applications', tokens[u], {})).data.id);
  await call('POST', `/api/applications/${ids[0]}/approve`, tokens.manager1, {});
  await call('POST', `/api/applications/${ids[1]}/approve`, tokens.manager1, {});
  show('charlie 신청 승인 시도', brief(await call('POST', `/api/applications/${ids[2]}/approve`, tokens.manager1, {})));
  show('GET /api/events approvedCount', (await call('GET', '/api/events')).data.map(e => ({ id: e.id, capacity: e.capacity, approvedCount: e.approvedCount })));
  show('applications', apps());

  // 3) 대기 순서: created_at이 다른 경우 / 같은 경우 (R5)
  reset();
  log('\n# 시나리오 3-1: created_at이 다르면 더 이른 대기자 승급 (T18)');
  const x = (await call('POST', '/api/events/2/applications', tokens.alice, {})).data.id;
  await call('POST', `/api/applications/${x}/approve`, tokens.manager2, {});
  const b = (await call('POST', '/api/events/2/applications', tokens.bob, {})).data.id;
  const c = (await call('POST', '/api/events/2/applications', tokens.charlie, {})).data.id;
  db.prepare('UPDATE applications SET created_at=? WHERE id=?').run('2026-11-02T00:00:00.000Z', b);
  db.prepare('UPDATE applications SET created_at=? WHERE id=?').run('2026-11-01T00:00:00.000Z', c);
  show('승인 취소 전 applications', apps());
  let r = await call('POST', `/api/applications/${x}/revoke`, tokens.manager2, { reason: '운영 사정으로 승인 취소' });
  show('revoke 응답', { status: r.status, revoked: { id: r.data.revoked.id, status: r.data.revoked.status }, promoted: r.data.promoted && { id: r.data.promoted.id, applicantName: r.data.promoted.applicantName, status: r.data.promoted.status } });

  reset();
  log('\n# 시나리오 3-2: created_at이 같으면 작은 ID 승급 (T19)');
  const x2 = (await call('POST', '/api/events/2/applications', tokens.alice, {})).data.id;
  await call('POST', `/api/applications/${x2}/approve`, tokens.manager2, {});
  await call('POST', '/api/events/2/applications', tokens.bob, {});
  await call('POST', '/api/events/2/applications', tokens.charlie, {});
  db.prepare("UPDATE applications SET created_at='2026-11-01T00:00:00.000Z' WHERE status='PENDING'").run();
  show('승인 취소 전 applications', apps());
  r = await call('POST', `/api/applications/${x2}/revoke`, tokens.manager2, { reason: '운영 사정으로 승인 취소' });
  show('revoke 응답', { status: r.status, promoted: r.data.promoted && { id: r.data.promoted.id, applicantName: r.data.promoted.applicantName } });
  show('history', hist());

  // 4) T29 롤백: AUTO_APPROVE 이력 저장 실패 주입 후 재시도 (R7)
  reset();
  log('\n# 시나리오 4: 자동 승급 이력 저장 실패 → 전체 롤백 → 재시도 (T29)');
  const p = (await call('POST', '/api/events/1/applications', tokens.alice, {})).data.id;
  await call('POST', `/api/applications/${p}/approve`, tokens.manager1, {});
  const q = (await call('POST', '/api/events/1/applications', tokens.bob, {})).data.id;
  const before = { applications: apps(), history: hist() };
  show('실패 주입 전 applications', before.applications); show('실패 주입 전 history', before.history);
  db.exec("CREATE TRIGGER fail_auto BEFORE INSERT ON application_history WHEN NEW.action='AUTO_APPROVE' BEGIN SELECT RAISE(ABORT,'TEST_INJECTED_FAILURE'); END");
  show('manager1 revoke (트리거 활성)', brief(await call('POST', `/api/applications/${p}/revoke`, tokens.manager1, { reason: '운영 사정으로 승인 취소' })));
  const after = { applications: apps(), history: hist() };
  show('실패 후 applications', after.applications); show('실패 후 history', after.history);
  show('요청 전과 동일한가', JSON.stringify(before) === JSON.stringify(after));
  db.exec('DROP TRIGGER fail_auto');
  r = await call('POST', `/api/applications/${p}/revoke`, tokens.manager1, { reason: '운영 사정으로 승인 취소' });
  show('트리거 제거 후 재시도', { status: r.status, revoked: r.data.revoked.status, promoted: r.data.promoted && { id: r.data.promoted.id, status: r.data.promoted.status } });
  show('재시도 후 applications', apps()); show('재시도 후 history', hist());
  void q;
} finally {
  await new Promise(r => server.close(r));
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

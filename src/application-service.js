import { AppError, missing, forbidden, invalidState } from './errors.js';

// TODO-01~04: 업무 규칙과 트랜잭션을 직접 구현합니다. docs/API.md를 먼저 읽으세요.
// actor는 검증된 로그인 사용자입니다. repo의 저장 함수는 권한을 검사하지 않습니다.
// 상태 변경과 이력 저장은 함께 성공하거나 함께 실패해야 합니다.
// 승인 취소와 자동 승급은 신청 2건 + 이력 2건을 한 트랜잭션으로 처리합니다.

const alreadyApplied = () => new AppError(409,'ALREADY_APPLIED','이미 이 행사에 신청한 기록이 있습니다.');
const capacityFull = () => new AppError(409,'CAPACITY_FULL','정원이 모두 찼습니다.');

// SQLite UNIQUE(event_id,user_id) 위반 여부 (최종 중복 방어선을 409로 변환하기 위함)
const isUniqueViolation = (err) => /UNIQUE constraint failed/i.test(String(err?.message));

export function createApplicationService(repo) {
  const { db } = repo;

  // [트랜잭션 경계] 검사(최신 상태 조회) + 상태 변경 + 이력 저장을 하나로 묶는다.
  // - BEGIN IMMEDIATE: 시작 시점에 쓰기 잠금을 잡아, 검사부터 저장까지 다른 연결의 변경이 끼어들지 못하게 한다.
  // - work() 안에서 던진 거부(4xx)·저장 오류(5xx) 모두 ROLLBACK 후 다시 던진다 → 요청 전 데이터 유지.
  // - 모두 성공했을 때만 COMMIT 한다.
  function inTransaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
  }

  // 신청 조회 + 담당 운영자 여부 확인 (검사 순서: 존재 → 권한)
  function loadForManager(actor, applicationId) {
    const app = repo.application(applicationId);
    if (!app) throw missing('신청');
    const event = repo.event(app.eventId);
    if (actor.role !== 'MANAGER' || event.managerId !== actor.id) throw forbidden();
    return { app, event };
  }

  return {
    // TODO-01: 행사·학생 역할·중복 검사 → PENDING 저장 + APPLY 이력.
    apply(actor, eventId) {
      try {
        return inTransaction(() => {
          const event = repo.event(eventId);
          if (!event) throw missing('행사');                                // 404
          if (actor.role !== 'STUDENT') throw forbidden();                   // 403
          if (repo.existing(eventId, actor.id)) throw alreadyApplied();      // 409 (CANCELLED·REVOKED 포함)
          const created = repo.insert(eventId, actor.id);                    // PENDING
          repo.addHistory({ applicationId: created.id, actorId: actor.id, action: 'APPLY', fromStatus: null, toStatus: 'PENDING' });
          return created;
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw alreadyApplied();                  // 동시 신청 등 최종 방어
        throw err;
      }
    },

    // TODO-02: 본인의 PENDING만 CANCELLED로 변경 + CANCEL 이력. (자동 승급 없음)
    cancel(actor, applicationId) {
      return inTransaction(() => {
        const app = repo.application(applicationId);
        if (!app) throw missing('신청');                                     // 404
        if (actor.role !== 'STUDENT' || app.userId !== actor.id) throw forbidden(); // 403
        if (app.status !== 'PENDING') throw invalidState();                  // 409
        const updated = repo.setStatus(app.id, 'CANCELLED');
        repo.addHistory({ applicationId: app.id, actorId: actor.id, action: 'CANCEL', fromStatus: 'PENDING', toStatus: 'CANCELLED' });
        return updated;
      });
    },

    // TODO-03: 담당자·PENDING·정원 검사 → APPROVED + APPROVE 이력.
    approve(actor, applicationId) {
      return inTransaction(() => {
        const { app, event } = loadForManager(actor, applicationId);       // 404 → 403
        if (app.status !== 'PENDING') throw invalidState();                  // 409 INVALID_STATE
        if (repo.approvedCount(event.id) >= event.capacity) throw capacityFull(); // 409 CAPACITY_FULL
        const updated = repo.setStatus(app.id, 'APPROVED');
        repo.addHistory({ applicationId: app.id, actorId: actor.id, action: 'APPROVE', fromStatus: 'PENDING', toStatus: 'APPROVED' });
        return updated;
      });
    },

    // TODO-04: 담당자·APPROVED 검사 → REVOKED + REVOKE 이력 → 다음 대기자 1명 AUTO_APPROVE.
    // 신청 2건 + 이력 2건을 한 트랜잭션으로 처리한다. 어느 단계든 실패하면 전체 ROLLBACK.
    revoke(actor, applicationId, reason) {
      return inTransaction(() => {
        const { app, event } = loadForManager(actor, applicationId);       // 404 → 403
        if (app.status !== 'APPROVED') throw invalidState();                 // 409 (반복 승인 취소 포함)

        // 1) 승인 취소 + REVOKE 이력 (사유는 app.js에서 trim·길이 검사 완료)
        const revoked = repo.setStatus(app.id, 'REVOKED');
        const revokeHistoryId = repo.addHistory({
          applicationId: app.id, actorId: actor.id, action: 'REVOKE',
          fromStatus: 'APPROVED', toStatus: 'REVOKED', reason
        });

        // 2) 같은 행사 PENDING 중 created_at ASC, id ASC 첫 1명만 자동 승급 (없으면 자리를 비움)
        const next = repo.nextPending(event.id);
        let promoted = null;
        if (next) {
          promoted = repo.setStatus(next.id, 'APPROVED');
          repo.addHistory({
            applicationId: next.id, actorId: actor.id, action: 'AUTO_APPROVE',
            fromStatus: 'PENDING', toStatus: 'APPROVED', causeHistoryId: revokeHistoryId
          });
        }
        return { revoked, promoted };
      });
    }
  };
}

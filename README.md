# 과제 2 신청 승인 서비스 (웹서비스설계)

학생이 행사에 참가를 신청하고, 담당 운영자가 정원 안에서 승인하거나 승인을 취소하는 서비스입니다. 승인 취소로 자리가 비면 같은 행사에서 가장 먼저 신청한 대기자 1명을 자동으로 승인합니다. 모든 상태 변경과 변경 이력 저장은 하나의 트랜잭션으로 처리합니다.

- 보고서: [docs/report.pdf](docs/report.pdf)
- API 계약(제공): [docs/API.md](docs/API.md)

## 구현 요약

| 항목 | 상태 |
|---|---|
| TODO-01 `apply` 참가 신청 | 완료 |
| TODO-02 `cancel` 대기 취소 | 완료 |
| TODO-03 `approve` 승인 (담당자·상태·정원 검사) | 완료 |
| TODO-04 `revoke` 승인 취소 + 다음 대기자 1명 자동 승인 + 원인 이력 연결 | 완료 |
| 필수 테스트 `npm run test:assignment` (T01~T32) | 32/32 통과 |
| 기본 테스트 `npm test` | 4/4 통과 |
| 선택 심화 `npm run test:advanced` (서버 2개 동시 승인 20회) | 통과 |
| 화면 검증 U01~U05 | 완료 (보고서 7장, `docs/screenshots/`) |

### 직접 변경한 파일

- `src/application-service.js`: TODO-01~04 구현. 공통 함수 `inTransaction()`(BEGIN IMMEDIATE → COMMIT, 오류 시 ROLLBACK), `loadForManager()`(담당 운영자 확인), 오류 생성 `alreadyApplied()`·`capacityFull()`, UNIQUE 위반을 409로 바꾸는 `isUniqueViolation()` 추가.
- `src/repository.js`: 다음 대기자를 찾는 `nextPending()` 1개 추가 (같은 행사 · PENDING · `created_at`, `id` 오름차순 · 1건).
- `docs/`: 보고서 PDF, 화면·테스트 캡처(`screenshots/`), 검증 증거(`evidence/`)를 추가.

그 밖의 파일(`src/app.js`, `auth.js`, `db.js`, `errors.js`, `server.js`, `public/`, `scripts/`, `tests/`)은 제공된 그대로이며, 테스트 기대값과 검사는 바꾸지 않았습니다.

### 검증 증거

- `docs/screenshots/`: U01~U05 화면 캡처, 테스트 3종 실행 화면
- `docs/evidence/test-results.txt`: 테스트 3종 전체 출력
- `docs/evidence/scenarios.js`, `scenarios-output.txt`: 거부·정원 초과·대기 순서·롤백(T29) 상황의 HTTP 응답과 DB 전후 데이터. `node docs/evidence/scenarios.js`로 다시 실행할 수 있고, 번호를 붙이면(`... scenarios.js 4`) 해당 시나리오만 출력합니다.

### 실행 환경

Windows 11 Pro · Node.js v24.21.0 · npm 11.19.0

### 알려진 한계

- 동시 요청은 SQLite 쓰기 잠금으로 한 번에 하나씩 처리합니다. 요청이 많이 몰려 5초 넘게 기다리면 500 오류가 날 수 있습니다.
- DB 파일 하나를 쓰는 구조를 기준으로 합니다. 여러 DB 서버로 나누는 구조에는 다른 설계가 필요합니다.

### AI 사용 요약

Claude Code를 구현 코드 작성 보조, 트랜잭션·롤백·검사 순서 설명, 증거 스크립트·다이어그램 작성, 이해되지 않는 코드와 개념 설명에 사용했습니다. AI가 작성한 코드는 테스트와 화면 확인으로 직접 검증했습니다. 자세한 내용은 보고서 7장에 있습니다.

---

아래는 제공된 시작 코드 안내입니다.

## 실행

Node.js **24.x**와 npm이 필요합니다. Node.js 20은 지원하지 않습니다. SQLite는 Node 내장 모듈입니다.

```sh
node --version
npm ci
npm test
npm start
```

http://127.0.0.1:3000 에 접속합니다. Ctrl+C로 종료합니다.

- 포트 사용 중: 기존 실행 터미널을 종료하거나 다른 포트를 사용합니다.
- macOS / Linux: `PORT=3001 npm start`
- Windows PowerShell: `$env:PORT="3001"; npm start`
- 첫 실행: `data/app.sqlite`와 `data/jwt-secret.txt`가 자동 생성됩니다.
- 브라우저 로그인 토큰은 메모리에만 저장합니다. 새로고침 후 다시 로그인하세요. DB 데이터는 유지됩니다.

## 연습 계정

공통 비밀번호는 `Classroom123!`입니다. 실제 이용자가 아닌 가상 계정입니다.

|아이디|이름|역할|
|---|---|---|
|alice|민지|학생|
|bob|준호|학생|
|charlie|서연|학생|
|manager1|운영자 A|행사 1 담당 · 정원 2명|
|manager2|운영자 B|행사 2 담당 · 정원 1명|

로그인 화면의 계정 버튼으로 입력값을 채우고 로그인 버튼을 누릅니다. 각 탭은 별도 토큰을 사용하므로 일반 탭 여러 개로 역할을 나눌 수 있습니다.

## 제공 코드와 구현할 부분

로그인·JWT 인증, 스키마와 가상 계정, 조회 API와 권한 검사, 입력 형식 검사, 기본 화면, SQL 조회·저장 도구를 제공합니다.

`src/application-service.js`의 TODO 4개는 초기 상태에서 501을 반환합니다.

1. `apply`: 행사·학생·중복 검사, PENDING 저장과 APPLY 이력
2. `cancel`: 학생 본인의 PENDING 취소, CANCELLED와 CANCEL 이력
3. `approve`: 담당자·상태·정원 검사, APPROVED와 APPROVE 이력
4. `revoke`: 담당자의 승인 취소, 다음 대기자 1명 승급, 두 이력의 원인 연결

모든 상태 변경과 이력 저장을 트랜잭션으로 묶으세요. 특히 revoke에서는 신청 2건과 이력 2건의 부분 저장을 막아야 합니다. 대기자 선택, 업무 규칙, 이력 저장 시점, 트랜잭션 경계는 학생 구현입니다. repository 함수 자체는 권한을 검사하지 않습니다. 보조 함수·SQL·파일은 필요하면 추가할 수 있습니다.

## 테스트

```sh
npm test
npm run test:assignment
npm run test:advanced
```

- `npm test`: 제공 기반 기능 4개. 구현 전과 후 모두 통과해야 합니다.
- `test:assignment`: 필수 32개. TODO 구현 전 일부 실패가 정상입니다.
- `test:advanced`: 선택 심화. 서버 2개가 마지막 자리를 동시에 승인하는 검사를 20회 수행합니다. 미수행은 감점하지 않습니다.

테스트는 별도 임시 DB·포트를 사용합니다. 필수 테스트 T28~T30은 임시 DB 트리거로 이력 저장 실패를 주입합니다. `TEST_INJECTED_FAILURE` 로그는 이 검사의 의도된 오류입니다. HTTP 500뿐 아니라 상태·이력 전체가 요청 전과 같은지 검사합니다. 테스트가 오류를 흉내 내므로 실제 서비스 코드에 특별 처리를 넣지 마세요. 기대값 변경이나 테스트 삭제는 허용하지 않습니다.

## 화면 검증

- U01: alice 신청 → manager1 승인 → 학생이 최신 상태 확인.
- U02: 운영자가 대기 목록 조회 → 학생이 대기 취소 → 오래된 운영자 화면의 승인 거부(409)와 CANCELLED 유지.
- U03: 서버 종료·재실행 → 재로그인 → 신청 상태와 이력 유지.
- U04: 새 DB에서 행사 2에 alice·bob·charlie 순서로 신청 → manager2가 alice 승인 → alice 승인 취소(사유 입력) → bob 자동 승인, charlie 대기 유지 → alice와 bob의 변경 이력에서 원인 ID 연결 확인.
- U05: 새 DB에서 alice만 행사 2 신청·승인 → 승인 취소 → REVOKED, 승인 인원 0명, 응답 promoted=null 확인.

승인 취소는 담당 운영자 화면의 승인된 신청에서 수행합니다. 각 신청의 ‘변경 이력 보기’로 저장 결과를 확인합니다. 다른 탭의 변경은 자동 반영되지 않으므로 ‘최신 정보 새로고침’을 사용하세요.

## DB 초기화와 이전 코드에서의 전환

서버를 먼저 종료하고 아래 명령에서 `RESET`을 입력합니다. 신청·변경 이력을 지우고 초기 계정·행사를 다시 만듭니다.

```sh
npm run db:reset
```

이전 배포본 DB에는 REVOKED 상태와 변경 이력 스키마가 없습니다. 새 배포본에서는 기존 DB를 초기화하세요. 운영 데이터 마이그레이션은 이 과제 범위가 아닙니다.

선택 환경변수: PORT, DB_PATH, JWT_SECRET. 기본 실행에는 설정 파일이 필요 없습니다. 키 파일을 지우면 기존 토큰은 무효화됩니다.

## 파일 구조

- `src/application-service.js`: 학생 구현 TODO 4개와 트랜잭션
- `src/repository.js`: 조회·저장·이력 저장 도구
- `src/db.js`: SQLite 스키마·초기 데이터
- `src/auth.js`: JWT 인증
- `src/app.js`: 라우팅·형식 검사·조회 권한·오류 응답
- `src/server.js`: 로컬 서버
- `public/`: 승인 취소·이력 조회 포함 제공 화면
- `tests/`: 기반·필수·선택 심화 테스트
- `docs/API.md`: 상태·이력·입출력 계약

## 참고 문서

- [Node.js SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)
- [Express API](https://expressjs.com/en/5x/api/)
- [jsonwebtoken](https://github.com/auth0/node-jsonwebtoken)

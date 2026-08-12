# Repo Atlas

Repo Atlas는 공개 GitHub 저장소 URL을 저장하면 메타데이터를 먼저 보존하고, README를 바탕으로 한국어 요약·분류·태그를 만드는 개인용 개발자 도구입니다. PIN으로 보호되는 단일 사용자 Cloudflare Worker/D1 애플리케이션이며 브라우저는 GitHub나 OpenAI에 직접 연결하지 않습니다.

## 현재 상태

- 현재 코드는 `gx.zra.workers.dev` 단일 production 호스트와 GitHub Actions release/rollback 계약을 기준으로 합니다.
- 운영 절차와 필수 검증은 `docs/operations/release.md`에서 관리합니다.
- test 환경의 ID, namespace, host, PIN은 운영에 재사용하지 않습니다.

## 로컬 실행

Node.js `24.18.0`이 필요합니다.

```powershell
npm ci
npx playwright install --with-deps chromium firefox webkit chrome msedge
npx wrangler d1 migrations apply PROD_DB --local --env test
npx wrangler dev --env test
```

로그인 전에 ignored `.dev.vars.test`에 `test/support/harness.js`의 다섯 test-only secret 값을 넣습니다. 로컬 test 전용 PIN은 `123456`이며 배포 PIN과 무관합니다. standalone dev의 provider service는 보장하지 않으므로 저장/AI 흐름은 fixture를 함께 시작하는 `npm test`와 `npm run test:e2e`로 검증합니다. test 값을 운영에 사용하면 안 됩니다.

검증 명령:

```powershell
npm run check
npm test
npm run test:e2e
```

`npm run check`는 타입, CSS, 소스 정책, 단위 검사를 묶습니다. `npm test`는 단위·Wrangler/D1 통합 검사를 실행하고, `npm run test:e2e`는 설치한 브라우저에서 접근성·JavaScript 비활성 흐름을 확인합니다.

## 구조

- `src/worker.js` — exact-host 런타임 선택, 라우팅, 보안 헤더, HTTP 경계
- `src/auth.js` — PIN, 로그인 제한, 서명 세션, CSRF
- `src/domain.js` — GitHub URL·검색·수정 입력 규칙
- `src/github.js` — 공개 GitHub REST 경계와 README 수집
- `src/openai.js` — native `fetch`, strict JSON Schema, 응답 재검증
- `src/repositories.js` — D1 선저장, 수집·검색·수정·갱신·삭제 조정
- `src/html.js` — escape된 semantic HTML renderer
- `src/telemetry.js` — redacted 일별 집계와 CSP 보고
- `public/assets/` — Native CSS와 브라우저 ESM
- `migrations/` — expand/contract D1 schema
- `scripts/` — source policy와 불변 release 생성·검증

No-build 원칙에 따라 브라우저 자산은 번들링·트랜스파일하지 않습니다. Semantic HTML, Native CSS/ESM, Cascade Layers, 접근성 기본 동작을 유지하며 운영 `dependencies`는 0개입니다. CDN 자산, 프런트엔드 framework, router, ORM, OpenAI SDK를 추가하지 않습니다.

## v1 경계

- 공개 GitHub 저장소만 지원합니다. 비공개 저장소, OAuth, 사용자 GitHub token은 범위 밖입니다.
- 저장소는 최대 1,000개이며 검색·필터·페이지 이동은 서버에서 처리합니다.
- GitHub 메타데이터는 AI 호출 전에 저장됩니다. AI 분석이 실패해도 레코드를 지우지 않고 부분 성공 상태와 수동 재시도를 제공합니다.
- PIN은 개인용 단일 사용자 전제입니다. 공개 또는 다중 사용자 서비스로 바뀌면 인증 공급자가 먼저 필요합니다.

## 문서

- [릴리스·복구 runbook](docs/operations/release.md)

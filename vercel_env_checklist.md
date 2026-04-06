# Vercel 배포용 환경 변수 체크리스트

Vercel Dashboard → Project → **Settings** → **Environment Variables** 에서 아래 이름을 그대로 추가하고 값을 붙여넣으면 됩니다.

**적용 범위 권장:** `Production`, `Preview`, `Development` 모두 동일하게 넣어두는 것이 가장 단순합니다. (Preview만 다르게 쓰려면 별도 값을 등록하세요.)

---

## 필수 (앱이 동작하지 않거나 핵심 기능이 막힘)

| 변수 이름 | 설명 | 사용 위치 |
|-----------|------|-----------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 프로젝트 URL (`https://xxxxx.supabase.co`) | 브라우저(`page.tsx`), 서버 API(`analyze`, `sync-past`) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase **anon(public)** API 키 | 브라우저·서버에서 Supabase 클라이언트 생성 |
| `G2B_API_KEY` | 공공데이터포털에서 발급한 **일반 인증키**(조달청 입찰/개찰 API용). 값에 따옴표가 들어가면 코드에서 제거하지만, Vercel에는 **따옴표 없이** 넣는 것을 권장 | `/api/g2b`, `/api/result`, (간접) `/api/sync-current` |
| `CLOUDCONVERT_API_KEY` | CloudConvert API 키 (Bearer). HWP → TXT 변환 및 쿼터 조회에 사용 | `/api/analyze`, `/api/quota` |

---

## 강력 권장 (서버 전용 기능·RLS 대응)

| 변수 이름 | 설명 | 사용 위치 |
|-----------|------|-----------|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase **service_role** 키 (**절대** 클라이언트/브라우저에 노출 금지). `NEXT_PUBLIC_` 접두사를 붙이지 마세요. | `/api/sync-past` — `saved_bids` 조용한 업데이트 시 RLS를 우회하기 위해 사용. 없으면 코드는 `NEXT_PUBLIC_SUPABASE_ANON_KEY`로 폴백하지만, RLS 정책에 따라 **업데이트가 실패할 수 있음** |

> **보안:** `SUPABASE_SERVICE_ROLE_KEY`는 **Production / Preview**에만 넣고, 팀원 접근을 제한하는 것을 권장합니다.

---

## 선택 (코드에서 읽지만 현재 미사용·대체 경로 있음)

| 변수 이름 | 설명 |
|-----------|------|
| `SUPABASE_SERVICE_ROLE` | `sync-past`에서 `SUPABASE_SERVICE_ROLE_KEY`가 없을 때만 대체로 읽는 별칭. 둘 중 하나만 있으면 됩니다. |

---

## 환경 변수로 넣지 않는 값 (혼동 방지)

| 항목 | 설명 |
|------|------|
| **Gemini API Key (Next 런타임)** | `/api/analyze`는 요청 폼의 `geminiKey`를 사용합니다. **Vercel에 `GEMINI_API_KEY`를 넣어도 웹 앱 라우트는 읽지 않습니다.** (서버 env로 고정 키를 쓰려면 코드 변경이 필요합니다.) |

---

## 로컬 전용 (Vercel에 넣을 필요 없음)

| 변수 이름 | 설명 |
|-----------|------|
| `GEMINI_API_KEY` | `scripts/list-gemini-models.mjs` 실행 시에만 사용. `.env.local`에 두면 됨. |
| `GOOGLE_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` / `GOOGLE_AI_API_KEY` | 위 스크립트의 **대체** 키 이름(스크립트가 순서대로 탐색). |

---

## 배포 후 빠른 동작 확인

1. 메인 페이지 로드 → Supabase 연결 오류가 없는지  
2. **API 최신화** → `G2B_API_KEY` 정상 여부  
3. **HWP 업로드 분석** → `CLOUDCONVERT_API_KEY` 정상 여부  
4. CloudConvert 크레딧 표시 → `/api/quota`  
5. (보관함 사용 시) 백그라운드 **과거 공고 보정** → `SUPABASE_SERVICE_ROLE_KEY` 없으면 DB 정책에 따라 실패할 수 있음  

---

## `maxDuration = 60` 과 Vercel 플랜

아래 API Route 파일에는 import 직후에 `export const maxDuration = 60` 이 있습니다.

| 파일 |
|------|
| `src/app/api/analyze/route.ts` |
| `src/app/api/g2b/route.ts` |
| `src/app/api/g2b/detail/route.ts` |
| `src/app/api/result/route.ts` |
| `src/app/api/quota/route.ts` |
| `src/app/api/sync-current/route.ts` |
| `src/app/api/sync-past/route.ts` |

**Vercel 플랜에 따라 서버리스 함수의 실제 최대 실행 시간 상한이 `60`보다 짧을 수 있습니다.** (무료 플랜은 플랜 문서 기준 상한이 더 짧은 경우가 많습니다.)  
긴 조달·변환·AI 분석이 504로 끊기면 **상위 플랜** 또는 **작업 분할(큐/외부 워커)** 을 검토하세요.

---

## 로컬과 동일하게 맞추려면

로컬의 `.env.local`에 들어 있는 위 변수들을 Vercel에도 동일한 **이름**으로 복사하면 됩니다. (`NEXT_PUBLIC_*` 만 브라우저에 노출된다는 점만 유의하세요.)

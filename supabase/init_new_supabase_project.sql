-- =============================================================================
-- 새 Supabase 프로젝트 초기화 / 기존 DB 스키마 보강 (한 번에 실행)
-- 앱 코드 기준: src/app/page.tsx, src/app/api/analyze/route.ts,
--               src/app/api/sync-past/route.ts
--
-- 증상: PostgREST 400 — 존재하지 않는 컬럼(notice_date 등) 또는 테이블 참조
-- 해결: 테이블 생성 + 누락 컬럼만 추가 + RLS + 트리거 + API 역할 GRANT
-- =============================================================================
-- Supabase Dashboard → SQL Editor → 전체 붙여넣기 → Run
-- (멱등: 여러 번 실행해도 안전)
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) 앱 설정 (단일 행 id = 1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  gemini_api_key TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT app_settings_single_row CHECK (id = 1)
);

-- ---------------------------------------------------------------------------
-- 2) AI 프롬프트 템플릿
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.prompts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prompts_created_at ON public.prompts (created_at ASC);

-- ---------------------------------------------------------------------------
-- 3) 보관함 / 영업 파이프라인 (saved_bids)
--    예전 스크립트(saved_bids.sql)로 만든 테이블도 아래 ADD COLUMN으로 보강됨
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.saved_bids (
  bid_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  org TEXT,
  notice_date TEXT,
  deadline TEXT,
  budget TEXT,
  status TEXT,
  summary TEXT NOT NULL DEFAULT '-',
  phone TEXT,
  email TEXT,
  memo TEXT NOT NULL DEFAULT '',
  is_emailed BOOLEAN NOT NULL DEFAULT FALSE,
  ceo_feedback TEXT,
  is_ceo_checked BOOLEAN NOT NULL DEFAULT FALSE,
  manual_phone TEXT,
  manual_email TEXT,
  is_feedback_read BOOLEAN NOT NULL DEFAULT FALSE,
  result_status TEXT,
  result_winner TEXT,
  bid_result TEXT,
  notice_number TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 이미 테이블만 있는 경우: 컬럼만 순서대로 보강 (400 에러 방지 핵심)
ALTER TABLE public.saved_bids ADD COLUMN IF NOT EXISTS org TEXT;
ALTER TABLE public.saved_bids ADD COLUMN IF NOT EXISTS notice_date TEXT;
ALTER TABLE public.saved_bids ADD COLUMN IF NOT EXISTS deadline TEXT;
ALTER TABLE public.saved_bids ADD COLUMN IF NOT EXISTS budget TEXT;
ALTER TABLE public.saved_bids ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE public.saved_bids ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE public.saved_bids ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE public.saved_bids ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE public.saved_bids ADD COLUMN IF NOT EXISTS memo TEXT;
ALTER TABLE public.saved_bids ADD COLUMN IF NOT EXISTS is_emailed BOOLEAN;
ALTER TABLE public.saved_bids ADD COLUMN IF NOT EXISTS ceo_feedback TEXT;
ALTER TABLE public.saved_bids ADD COLUMN IF NOT EXISTS is_ceo_checked BOOLEAN;
ALTER TABLE public.saved_bids ADD COLUMN IF NOT EXISTS manual_phone TEXT;
ALTER TABLE public.saved_bids ADD COLUMN IF NOT EXISTS manual_email TEXT;
ALTER TABLE public.saved_bids ADD COLUMN IF NOT EXISTS is_feedback_read BOOLEAN;
ALTER TABLE public.saved_bids ADD COLUMN IF NOT EXISTS result_status TEXT;
ALTER TABLE public.saved_bids ADD COLUMN IF NOT EXISTS result_winner TEXT;
ALTER TABLE public.saved_bids ADD COLUMN IF NOT EXISTS bid_result TEXT;
ALTER TABLE public.saved_bids ADD COLUMN IF NOT EXISTS notice_number TEXT;
ALTER TABLE public.saved_bids ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
ALTER TABLE public.saved_bids ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- NOT NULL / 기본값 보정 (과거 NULL 허용 컬럼이 있던 경우)
UPDATE public.saved_bids SET title = '' WHERE title IS NULL;
UPDATE public.saved_bids SET summary = '-' WHERE summary IS NULL;
UPDATE public.saved_bids SET memo = '' WHERE memo IS NULL;
UPDATE public.saved_bids SET is_emailed = FALSE WHERE is_emailed IS NULL;
UPDATE public.saved_bids SET is_ceo_checked = FALSE WHERE is_ceo_checked IS NULL;
UPDATE public.saved_bids SET is_feedback_read = FALSE WHERE is_feedback_read IS NULL;
UPDATE public.saved_bids SET created_at = NOW() WHERE created_at IS NULL;
UPDATE public.saved_bids SET updated_at = NOW() WHERE updated_at IS NULL;

ALTER TABLE public.saved_bids ALTER COLUMN title SET DEFAULT '';
ALTER TABLE public.saved_bids ALTER COLUMN title SET NOT NULL;
ALTER TABLE public.saved_bids ALTER COLUMN summary SET DEFAULT '-';
ALTER TABLE public.saved_bids ALTER COLUMN summary SET NOT NULL;
ALTER TABLE public.saved_bids ALTER COLUMN memo SET DEFAULT '';
ALTER TABLE public.saved_bids ALTER COLUMN memo SET NOT NULL;
ALTER TABLE public.saved_bids ALTER COLUMN is_emailed SET DEFAULT FALSE;
ALTER TABLE public.saved_bids ALTER COLUMN is_emailed SET NOT NULL;
ALTER TABLE public.saved_bids ALTER COLUMN is_ceo_checked SET DEFAULT FALSE;
ALTER TABLE public.saved_bids ALTER COLUMN is_ceo_checked SET NOT NULL;
ALTER TABLE public.saved_bids ALTER COLUMN is_feedback_read SET DEFAULT FALSE;
ALTER TABLE public.saved_bids ALTER COLUMN is_feedback_read SET NOT NULL;
ALTER TABLE public.saved_bids ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE public.saved_bids ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE public.saved_bids ALTER COLUMN updated_at SET DEFAULT NOW();
ALTER TABLE public.saved_bids ALTER COLUMN updated_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_saved_bids_notice_date ON public.saved_bids (notice_date DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_saved_bids_updated_at ON public.saved_bids (updated_at DESC);

-- ---------------------------------------------------------------------------
-- 4) 대시보드「분석 완료」토글
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.analyzed_bids (
  bid_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.analyzed_bids ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
UPDATE public.analyzed_bids SET created_at = NOW() WHERE created_at IS NULL;
ALTER TABLE public.analyzed_bids ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE public.analyzed_bids ALTER COLUMN created_at SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 5) AI 분석 요약 캐시
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_analysis_cache (
  bid_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.ai_analysis_cache ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE public.ai_analysis_cache ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
UPDATE public.ai_analysis_cache SET summary = '' WHERE summary IS NULL;
UPDATE public.ai_analysis_cache SET updated_at = NOW() WHERE updated_at IS NULL;
ALTER TABLE public.ai_analysis_cache ALTER COLUMN summary SET DEFAULT '';
ALTER TABLE public.ai_analysis_cache ALTER COLUMN summary SET NOT NULL;
ALTER TABLE public.ai_analysis_cache ALTER COLUMN updated_at SET DEFAULT NOW();
ALTER TABLE public.ai_analysis_cache ALTER COLUMN updated_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_analysis_cache_updated_at ON public.ai_analysis_cache (updated_at DESC);

-- ---------------------------------------------------------------------------
-- 6) 나라장터 개찰 결과 캐시
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.g2b_result_cache (
  bid_id TEXT PRIMARY KEY,
  bid_result TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.g2b_result_cache ADD COLUMN IF NOT EXISTS bid_result TEXT;
ALTER TABLE public.g2b_result_cache ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
UPDATE public.g2b_result_cache SET updated_at = NOW() WHERE updated_at IS NULL;
ALTER TABLE public.g2b_result_cache ALTER COLUMN updated_at SET DEFAULT NOW();
ALTER TABLE public.g2b_result_cache ALTER COLUMN updated_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_g2b_result_cache_updated_at ON public.g2b_result_cache (updated_at DESC);

-- ---------------------------------------------------------------------------
-- RLS (anon 키 — 개발 편의용 전체 허용; 프로덕션에서는 정책 좁히기 권장)
-- ---------------------------------------------------------------------------
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_bids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analyzed_bids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_analysis_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.g2b_result_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all for app_settings" ON public.app_settings;
CREATE POLICY "Allow all for app_settings"
  ON public.app_settings FOR ALL
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all for prompts" ON public.prompts;
CREATE POLICY "Allow all for prompts"
  ON public.prompts FOR ALL
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all for saved_bids" ON public.saved_bids;
CREATE POLICY "Allow all for saved_bids"
  ON public.saved_bids FOR ALL
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all for analyzed_bids" ON public.analyzed_bids;
CREATE POLICY "Allow all for analyzed_bids"
  ON public.analyzed_bids FOR ALL
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all for ai_analysis_cache" ON public.ai_analysis_cache;
CREATE POLICY "Allow all for ai_analysis_cache"
  ON public.ai_analysis_cache FOR ALL
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all for g2b_result_cache" ON public.g2b_result_cache;
CREATE POLICY "Allow all for g2b_result_cache"
  ON public.g2b_result_cache FOR ALL
  USING (true) WITH CHECK (true);

-- PostgREST(anon)가 테이블에 접근할 수 있게 권한 부여 (새 프로젝트에서 누락 방지)
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.app_settings TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.prompts TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.saved_bids TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.analyzed_bids TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_analysis_cache TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.g2b_result_cache TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- updated_at 자동 갱신
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_app_settings_updated_at ON public.app_settings;
CREATE TRIGGER trg_app_settings_updated_at
  BEFORE UPDATE ON public.app_settings
  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

DROP TRIGGER IF EXISTS trg_prompts_updated_at ON public.prompts;
CREATE TRIGGER trg_prompts_updated_at
  BEFORE UPDATE ON public.prompts
  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

DROP TRIGGER IF EXISTS trg_saved_bids_updated_at ON public.saved_bids;
CREATE TRIGGER trg_saved_bids_updated_at
  BEFORE UPDATE ON public.saved_bids
  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

DROP TRIGGER IF EXISTS trg_ai_analysis_cache_updated_at ON public.ai_analysis_cache;
CREATE TRIGGER trg_ai_analysis_cache_updated_at
  BEFORE UPDATE ON public.ai_analysis_cache
  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

DROP TRIGGER IF EXISTS trg_g2b_result_cache_updated_at ON public.g2b_result_cache;
CREATE TRIGGER trg_g2b_result_cache_updated_at
  BEFORE UPDATE ON public.g2b_result_cache
  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 선택: app_settings 기본 행
-- ---------------------------------------------------------------------------
INSERT INTO public.app_settings (id, gemini_api_key)
VALUES (1, NULL)
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- =============================================================================
-- 실행 후: Table Editor에서 위 6개 테이블과 saved_bids 컬럼 목록을 확인하세요.
-- 환경 변수 NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY 가
-- 이 프로젝트 것과 일치하는지도 함께 확인하세요.
-- =============================================================================

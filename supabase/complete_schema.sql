-- =============================================================================
-- Venue Finder Web — Supabase 전체 스키마 (SQL Editor에 한 번에 실행)
-- 앱 코드: page.tsx, api/analyze, api/sync-past 기준
-- =============================================================================
-- 참고: 나라장터 공고 마스터 목록은 DB에 저장하지 않음(API 실시간 + 클라이언트 상태).
--       e-발주 제안요청 첨부는 세션 메모리 캐시만 사용(영속 테이블 없음).
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) 앱 설정 (단일 행: id = 1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  gemini_api_key TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT app_settings_single_row CHECK (id = 1)
);

COMMENT ON TABLE public.app_settings IS 'Gemini API 키 등 전역 설정 (프론트 설정 탭)';

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

COMMENT ON TABLE public.prompts IS '입찰 분석용 프롬프트 목록';

-- ---------------------------------------------------------------------------
-- 3) 보관함 / 영업 파이프라인 (saved_bids)
--    FK 없음: bid_id는 나라장터 입찰 식별자(텍스트)이며 마스터 테이블이 DB에 없음
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
  -- 파이프라인 확장
  ceo_feedback TEXT,
  is_ceo_checked BOOLEAN NOT NULL DEFAULT FALSE,
  manual_phone TEXT,
  manual_email TEXT,
  is_feedback_read BOOLEAN NOT NULL DEFAULT FALSE,
  -- 개찰/결과 (sync-past, 목록 연동)
  result_status TEXT,
  result_winner TEXT,
  -- UI 표시용(선택)
  notice_number TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saved_bids_notice_date ON public.saved_bids (notice_date DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_saved_bids_updated_at ON public.saved_bids (updated_at DESC);

COMMENT ON TABLE public.saved_bids IS '북마크(보관함) 및 영업 파이프라인 행';

-- ---------------------------------------------------------------------------
-- 4) 대시보드「분석 완료」토글 (공고별, 보관 여부와 무관)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.analyzed_bids (
  bid_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.analyzed_bids IS '분석 완료로 표시한 입찰 id (saved_bids와 독립)';

-- ---------------------------------------------------------------------------
-- 5) AI 분석 요약 캐시 (/api/analyze 업로드 분석 결과)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_analysis_cache (
  bid_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_analysis_cache_updated_at ON public.ai_analysis_cache (updated_at DESC);

COMMENT ON TABLE public.ai_analysis_cache IS '공고별 AI 요약 캐시 (handleRefresh 시 병합)';

-- ---------------------------------------------------------------------------
-- RLS (anon 키 사용 시 — 기존 프로젝트와 동일하게 개발 편의용 전체 허용)
-- 프로덕션에서는 정책을 auth·서비스 롤 기준으로 좁히는 것을 권장합니다.
-- ---------------------------------------------------------------------------
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_bids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analyzed_bids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_analysis_cache ENABLE ROW LEVEL SECURITY;

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

-- ---------------------------------------------------------------------------
-- 선택: updated_at 자동 갱신 트리거
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

-- ---------------------------------------------------------------------------
-- 선택: 초기 데이터 (앱이 prompts가 비어 있을 때만 로컬 기본값 사용)
-- ---------------------------------------------------------------------------
INSERT INTO public.app_settings (id, gemini_api_key)
VALUES (1, NULL)
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- =============================================================================
-- 끝. 에디터에서 한 번 실행 후 Table Editor로 테이블 생성 여부를 확인하세요.
-- =============================================================================

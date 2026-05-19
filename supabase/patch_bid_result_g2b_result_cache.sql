-- =============================================================================
-- 기존 Supabase 프로젝트용 일회 패치 (SQL Editor에서 실행)
-- 증상: saved_bids load / g2b_result_cache load / saved_bids result load 오류
-- 원인: saved_bids.bid_result 컬럼 없음, g2b_result_cache 테이블 없음
-- =============================================================================

BEGIN;

ALTER TABLE public.saved_bids ADD COLUMN IF NOT EXISTS bid_result TEXT;

CREATE TABLE IF NOT EXISTS public.g2b_result_cache (
  bid_id TEXT PRIMARY KEY,
  bid_result TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_g2b_result_cache_updated_at ON public.g2b_result_cache (updated_at DESC);

ALTER TABLE public.g2b_result_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all for g2b_result_cache" ON public.g2b_result_cache;
CREATE POLICY "Allow all for g2b_result_cache"
  ON public.g2b_result_cache FOR ALL
  USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_g2b_result_cache_updated_at ON public.g2b_result_cache;
CREATE TRIGGER trg_g2b_result_cache_updated_at
  BEFORE UPDATE ON public.g2b_result_cache
  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

COMMIT;

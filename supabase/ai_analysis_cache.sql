-- Supabase SQL Editor에서 실행하여 ai_analysis_cache 테이블 생성
-- (일괄 AI 분석 결과 캐시용)

CREATE TABLE IF NOT EXISTS ai_analysis_cache (
  bid_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS 정책 (anon 키로 API에서 쓰는 경우)
ALTER TABLE ai_analysis_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for ai_analysis_cache"
  ON ai_analysis_cache FOR ALL
  USING (true)
  WITH CHECK (true);

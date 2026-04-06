-- Supabase SQL Editor에서 실행하여 saved_bids 테이블 생성
-- (보관함 / 영업 파이프라인 연동)

CREATE TABLE IF NOT EXISTS saved_bids (
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
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE saved_bids ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for saved_bids"
  ON saved_bids FOR ALL
  USING (true)
  WITH CHECK (true);

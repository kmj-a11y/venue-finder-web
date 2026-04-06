import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';
export const maxDuration = 15;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function kstTodayDateString(): string {
  // YYYY-MM-DD in KST
  const s = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });
  return s.split(' ')[0];
}

function minusMonths(dateStrYmd: string, months: number): string {
  const [y, m, d] = dateStrYmd.split('-').map((x) => parseInt(x, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCMonth(dt.getUTCMonth() - months);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function parseBidId(bidId: string): { bidNo: string; bidOrd: string } | null {
  const s = String(bidId || '').trim();
  const m = s.match(/^(R\d{2}BK\d+)-(\d+)$/i);
  if (!m) return null;
  const bidNo = m[1];
  const bidOrd = m[2].padStart(3, '0');
  return { bidNo, bidOrd };
}

function isEmptyWinner(v: any): boolean {
  if (v == null) return true;
  const t = String(v).trim();
  return t === '' || t === '-' || t.toLowerCase() === 'null';
}

function isFinalizedStatus(v: any): boolean {
  if (v == null) return false;
  const t = String(v).trim();
  if (!t) return false;
  // 데이터 소스별 표현 차이를 흡수
  return /유찰/.test(t) || /낙찰/.test(t) || t === '개찰완료';
}

/**
 * Track B: 과거 미완료 공고 결과 보정(조용히 DB만 업데이트)
 * - 최근 3개월 + 확정(낙찰/유찰) 아님 + 수주업체명 비어있는 건만 타겟
 * - serverless timeout 방어: 최대 12건 + 0.5초 딜레이
 * - 프론트 UX 간섭 금지: 에러/성공 모두 토스트 없음 (서버 로그만)
 */
export async function GET(request: Request) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    '';

  if (!supabaseUrl || !serviceKey) {
    // 조용히 종료
    return NextResponse.json({ ok: false, processed: 0 }, { status: 200 });
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const todayKst = kstTodayDateString();
  const cutoff = minusMonths(todayKst, 3); // YYYY-MM-DD

  const LIMIT = 12; // 10~15 권장 범위
  const DELAY_MS = 500;

  let targets: Array<{
    bid_id: string;
    notice_date: string | null;
    result_status: string | null;
    result_winner: string | null;
    status: string | null;
  }> = [];

  try {
    // 1) 대상 필터링(가급적 DB에서 줄이기)
    // - notice_date >= cutoff
    // - result_winner 비어있음
    // - result_status 확정(유찰/낙찰) 아님
    //
    // Supabase 필터는 완벽한 "not like" 조합이 제한적이라,
    // winner empty는 DB에서, status finalized는 서버에서 2차 필터.
    const { data, error } = await supabase
      .from('saved_bids')
      .select('bid_id, notice_date, result_status, result_winner, status')
      .gte('notice_date', cutoff)
      .order('notice_date', { ascending: false })
      .limit(200); // 2차 필터 후 LIMIT 적용

    if (error) {
      console.error('sync-past select error:', error);
      return NextResponse.json({ ok: true, processed: 0 }, { status: 200 });
    }

    const rows = (data ?? []) as any[];
    targets = rows
      .filter((r) => r?.bid_id)
      .filter((r) => isEmptyWinner(r?.result_winner))
      .filter((r) => !isFinalizedStatus(r?.result_status))
      .slice(0, LIMIT);
  } catch (e) {
    console.error('sync-past query exception:', e);
    return NextResponse.json({ ok: true, processed: 0 }, { status: 200 });
  }

  let processed = 0;

  for (const row of targets) {
    try {
      const parsed = parseBidId(String(row.bid_id));
      if (!parsed) continue;

      const url = new URL('/api/result', request.url);
      url.searchParams.set('bidNo', parsed.bidNo);

      const res = await fetch(url.toString(), { cache: 'no-store', next: { revalidate: 0 } });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json) {
        // 조용히 스킵
      } else {
        const status = json?.status != null ? String(json.status) : null;
        const winner = json?.winner != null ? String(json.winner) : null;

        const winnerStr =
          winner && winner.trim() !== '' && winner.trim() !== '-' ? winner.trim() : null;
        const statusStr = status && status.trim() !== '' && status.trim() !== '-' ? status.trim() : null;

        // 확정 정보가 있는 경우만 부분 업데이트 (수기 컬럼 덮어쓰기 방지)
        if (winnerStr || statusStr) {
          const { error: upErr } = await supabase
            .from('saved_bids')
            .update({
              result_status: statusStr,
              result_winner: winnerStr,
            })
            .eq('bid_id', row.bid_id);
          if (upErr) {
            console.error('sync-past update error:', upErr);
          }
        }
      }
      processed += 1;
    } catch (e) {
      console.error('sync-past item error:', e);
    }

    // IP 차단 방지 딜레이 + serverless timeout 방어
    await sleep(DELAY_MS);
  }

  return NextResponse.json({ ok: true, processed }, { status: 200 });
}


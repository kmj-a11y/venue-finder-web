import { NextResponse } from 'next/server';

/** Vercel 서버리스 최대 실행 시간(초). 내부 `/api/g2b` 프록시 지연 대비 */
export const maxDuration = 60;

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Track A: 현재 선택 월 공고 동기화 (UI 블로킹 용도)
 * - 내부적으로 기존 `/api/g2b`를 호출해 동일한 응답을 반환한다.
 * - 프론트에서 기존 매핑/병합 로직을 그대로 재사용한다.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const month = searchParams.get('month') || '';
  const keyword = searchParams.get('keyword') || '';

  const url = new URL('/api/g2b', request.url);
  if (month) url.searchParams.set('month', month);
  if (keyword) url.searchParams.set('keyword', keyword);

  try {
    const res = await fetch(url.toString(), { cache: 'no-store', next: { revalidate: 0 } });
    const data = await res.json().catch(() => null);
    return NextResponse.json(data ?? { error: 'Upstream parse failed' }, { status: res.status });
  } catch (e: any) {
    console.error('sync-current error:', e);
    return NextResponse.json(
      { error: 'sync-current failed', detail: String(e?.message ?? e ?? '') },
      { status: 500 }
    );
  }
}


import { NextResponse } from 'next/server';

function formatKoreanCurrency(amount: unknown): string {
  const n = Number(amount);
  if (amount == null || amount === '' || !Number.isFinite(n) || n < 0) return '-';
  const eok = Math.floor(n / 1e8);
  const rest = n % 1e8;
  const man = rest / 1e4;
  if (eok > 0 && man >= 1) return `${eok}억 ${Math.floor(man).toLocaleString()}만원`;
  if (eok > 0) return `${eok}억원`;
  if (man >= 1) return `${Math.floor(man).toLocaleString()}만원`;
  return `${Math.floor(n).toLocaleString()}원`;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const bidNo = searchParams.get('bidNo')?.trim();
    if (!bidNo) {
      return NextResponse.json({ error: 'bidNo 쿼리 파라미터가 필요합니다.' }, { status: 400 });
    }

    const rawApiKey = (process.env.G2B_API_KEY || '').trim().replace(/['"]/g, '');
    if (!rawApiKey) {
      return NextResponse.json({ error: 'G2B_API_KEY가 설정되지 않았습니다.' }, { status: 500 });
    }

    const url = `https://apis.data.go.kr/1230000/as/ScsbidInfoService/getOpengResultListInfoServc?inqryDiv=4&bidNtceNo=${encodeURIComponent(bidNo)}&type=json&pageNo=1&numOfRows=10&ServiceKey=${rawApiKey}`;
    const res = await fetch(url, { cache: 'no-store' });
    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json({ error: '낙찰정보 조회 실패', detail: data }, { status: 502 });
    }

    const body = data?.response?.body ?? data?.body ?? null;
    const items = body?.items ?? null;
    const rawItem = items?.item != null ? items.item : items;
    const itemList = rawItem == null ? [] : Array.isArray(rawItem) ? rawItem : [rawItem];
    const first = itemList[0];

    if (!first) {
      return NextResponse.json({ status: '-', winner: '-', amount: '-' });
    }

    const status = first.progrsDivCdNm ?? first.progrsDivCd ?? '-';
    const opengCorpInfo = first.opengCorpInfo ?? '';
    const parts = opengCorpInfo ? String(opengCorpInfo).split('^') : [];

    let winner = '-';
    let amount = '-';
    if (status === '개찰완료' && parts.length > 0) {
      winner = (parts[0] ?? '').trim() || '-';
      const amountRaw = parts[3];
      if (amountRaw != null && amountRaw !== '') {
        const num = Number(String(amountRaw).replace(/[^0-9.-]/g, ''));
        amount = Number.isFinite(num) ? formatKoreanCurrency(num) : '-';
      }
    }

    return NextResponse.json({ status, winner, amount });
  } catch (error) {
    console.error('result API error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '서버 오류' },
      { status: 500 }
    );
  }
}

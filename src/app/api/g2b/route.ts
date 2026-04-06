import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** 한국 표준시(KST) 기준 오늘 날짜 (공공 입찰 일자와 맞추기 위함) */
function getKstTodayParts(): { y: number; m: number; d: number } {
  const s = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });
  const datePart = s.split(' ')[0];
  const [yStr, mStr, dStr] = datePart.split('-');
  return {
    y: parseInt(yStr, 10),
    m: parseInt(mStr, 10),
    d: parseInt(dStr, 10),
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const month = searchParams.get('month') || '2026-03';
  const keyword = searchParams.get('keyword') || '채용';

  const [yearStr, monStr] = month.split('-');
  const selYear = parseInt(yearStr, 10);
  const selMonth = parseInt(monStr, 10);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const yStr = yearStr;
  const mStr = pad2(selMonth);

  const lastDayOfMonth = new Date(selYear, selMonth, 0).getDate();

  const { y: curY, m: curM, d: curD } = getKstTodayParts();

  let endDay: number;
  if (selYear === curY && selMonth === curM) {
    // 선택한 월이 오늘(KST)과 같은 달이면 종료일을 '오늘 23:59'까지로 제한해 최신 공고만 조회
    endDay = Math.min(curD, lastDayOfMonth);
  } else {
    // 과거/미래 월은 해당 월 말일 23:59까지
    endDay = lastDayOfMonth;
  }

  const inqryBgnDt = `${yStr}${mStr}010000`;
  const inqryEndDt = `${yStr}${mStr}${pad2(endDay)}2359`;

  // 1. API 키: 환경변수에서 가져와 공백·따옴표만 제거 (인코딩/디코딩 없이 원본 키 사용)
  let rawApiKey = (process.env.G2B_API_KEY || '').trim();
  rawApiKey = rawApiKey.replace(/['"]/g, '').trim();

  if (!rawApiKey) {
    return NextResponse.json({ error: "API 키가 설정되지 않았습니다." }, { status: 500 });
  }

  /** 공고 게시일(또는 등록일) 기준 정렬용 숫자 키 — 최신이 앞에 오도록 내림차순에 사용 */
  function noticeDateSortKey(item: Record<string, unknown>): number {
    const raw = String(item.bidNtceDt ?? item.regDt ?? '').replace(/\D/g, '');
    const head = raw.slice(0, 14).padEnd(14, '0');
    const n = parseInt(head, 10);
    return Number.isFinite(n) ? n : 0;
  }

  /** 공공데이터포털은 건수 상한(보통 100)을 넘기면 오류·빈 응답이 나는 경우가 많아 100으로 고정 후 페이지네이션 */
  const NUM_OF_ROWS = 100;
  const MAX_PAGES = 50;

  function extractItemsChunk(body: Record<string, unknown> | undefined): Record<string, unknown>[] {
    if (!body) return [];
    const items = body.items as unknown;
    if (items == null || items === '') return [];
    if (Array.isArray(items)) return items as Record<string, unknown>[];
    if (typeof items === 'object' && items !== null && 'item' in items) {
      const raw = (items as { item?: unknown }).item;
      if (raw == null) return [];
      return Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [raw as Record<string, unknown>];
    }
    return [];
  }

  console.log(
    '🚀 조달청 API 호출 시작 (날짜:',
    inqryBgnDt,
    '~',
    inqryEndDt,
    ', 페이지당',
    NUM_OF_ROWS,
    '건)'
  );

  try {
    let firstData: Record<string, unknown> | null = null;
    const mergedItems: Record<string, unknown>[] = [];
    let pageNo = 1;

    while (pageNo <= MAX_PAGES) {
      const url = `https://apis.data.go.kr/1230000/ad/BidPublicInfoService/getBidPblancListInfoServcPPSSrch?ServiceKey=${rawApiKey}&pageNo=${pageNo}&numOfRows=${NUM_OF_ROWS}&type=json&inqryDiv=1&inqryBgnDt=${inqryBgnDt}&inqryEndDt=${inqryEndDt}&bidNtceNm=${encodeURIComponent(keyword)}`;

      const res = await fetch(url, {
        cache: 'no-store',
        next: { revalidate: 0 },
      });
      const text = await res.text();

      if (text.includes('SERVICE_KEY_IS_NOT_REGISTERED_ERROR')) {
        console.error("❌ 조달청 API 에러: 아직 키 동기화가 완료되지 않았습니다. (발급 후 1~2시간 소요)");
        console.error("   응답 일부:", text.substring(0, 300));
        return NextResponse.json(
          { error: "조달청 API 에러 (아직 키 동기화가 안 되었을 확률 99%)", detail: text.substring(0, 200) },
          { status: 502 }
        );
      }

      if (text.includes('Unexpected errors')) {
        console.error("❌ 공공데이터포털 서버 거절 (키 불일치 또는 서버 점검)");
        console.error("   응답 일부:", text.substring(0, 300));
        return NextResponse.json(
          { error: "공공데이터포털 연동 에러 (Unexpected errors)", detail: text.substring(0, 200) },
          { status: 502 }
        );
      }

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        console.error("❌ JSON 파싱 실패. 응답 앞 200자:", text.substring(0, 200));
        return NextResponse.json(
          { error: "조달청 API 응답 형식이 잘못되었습니다.", detail: text.substring(0, 200) },
          { status: 502 }
        );
      }

      if (pageNo === 1) {
        firstData = data;
      }

      const resp = data.response as
        | { header?: { resultCode?: string; resultMsg?: string }; body?: Record<string, unknown> }
        | undefined;
      const header = resp?.header;
      const resultCode = String(header?.resultCode ?? '').trim();
      // 03 등은 '조회 건수 없음'으로 빈 본문과 함께 오는 경우가 있어 200으로 비어 반환
      if (resultCode && resultCode !== '00' && resultCode !== '03') {
        console.error('❌ 조달청 API 비정상 응답:', header?.resultCode, header?.resultMsg);
        return NextResponse.json(
          {
            error: '조달청 API 오류',
            resultCode: header?.resultCode,
            resultMsg: header?.resultMsg ?? '',
          },
          { status: 502 }
        );
      }

      const body =
        resp?.body ??
        (data.body as Record<string, unknown> | undefined);
      if (!body) {
        break;
      }

      const asObjects = extractItemsChunk(body);
      if (asObjects.length === 0) {
        break;
      }

      mergedItems.push(...asObjects);

      if (asObjects.length < NUM_OF_ROWS) {
        break;
      }
      pageNo += 1;
    }

    if (!firstData) {
      return NextResponse.json(
        { error: "조달청 API 응답 형식이 잘못되었습니다.", detail: 'empty' },
        { status: 502 }
      );
    }

    mergedItems.sort((a, b) => noticeDateSortKey(b) - noticeDateSortKey(a));

    const out = JSON.parse(JSON.stringify(firstData)) as Record<string, unknown>;
    const outBody =
      (out.response as { body?: Record<string, unknown> } | undefined)?.body ??
      (out.body as Record<string, unknown> | undefined);
    if (outBody) {
      if (mergedItems.length === 0) {
        outBody.items = {};
      } else if (mergedItems.length === 1) {
        outBody.items = { item: mergedItems[0] };
      } else {
        outBody.items = { item: mergedItems };
      }
      outBody.totalCount = String(mergedItems.length);
      outBody.numOfRows = String(mergedItems.length);
    }

    return NextResponse.json(out);
  } catch (error) {
    console.error("❌ Fetch 통신 에러:", error);
    return NextResponse.json({ error: "서버 통신 실패" }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';

/** Vercel 서버리스 최대 실행 시간(초). CloudConvert API 지연 대비 */
export const maxDuration = 60;

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const apiKey = process.env.CLOUDCONVERT_API_KEY;
    if (!apiKey) {
      console.error('[Quota API] API Key가 .env.local에 없습니다.');
      return NextResponse.json({ credits: null, error: 'API Key missing' }, { status: 200 }); // 화면 터짐 방지를 위해 200 리턴
    }

    const res = await fetch('https://api.cloudconvert.com/v2/users/me', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store', // Next.js 캐싱 방지 (실시간 업데이트를 위해 필수)
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error(`[Quota API] CloudConvert 통신 에러 (${res.status}):`, errorText);
      return NextResponse.json({ credits: null, error: `API Error ${res.status}` }, { status: 200 });
    }

    const json = await res.json();
    return NextResponse.json({ credits: json.data?.credits ?? null });
  } catch (error: any) {
    console.error('[Quota API] 예상치 못한 서버 에러:', error.message);
    return NextResponse.json({ credits: null, error: error.message }, { status: 200 });
  }
}

// Supabase 무료 플랜은 7일간 사용이 없으면 프로젝트를 일시정지한다.
// Vercel Cron(vercel.json)이 3일마다 이 주소를 호출해 가벼운 조회 1번으로 깨워 둔다.
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  // CRON_SECRET 환경 변수가 있으면 Vercel Cron 호출만 허용
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return Response.json({ ok: false, error: 'Supabase 환경 변수 없음' }, { status: 500 });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  // 행 내용은 응답에 담지 않고, 조회가 됐는지만 확인
  const { error } = await supabase.from('app_settings').select('*', { count: 'exact', head: true });

  if (error) {
    console.error('[keepalive] Supabase 조회 실패:', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
  return Response.json({ ok: true, at: new Date().toISOString() });
}

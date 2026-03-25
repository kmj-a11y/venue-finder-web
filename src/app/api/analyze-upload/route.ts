import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  MAX_DOCUMENT_CHARS,
  extractTextFromPdf,
  extractTextFromHwpx,
  extractTextFromHwp,
  buildMetadataBlock,
  callGemini,
} from '../analyze/route';

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const bidRaw = formData.get('bid');
    const prompt = formData.get('prompt');
    const geminiKey = formData.get('geminiKey');
    const files = formData.getAll('files') as File[];

    if (!bidRaw || typeof bidRaw !== 'string' || !prompt || !geminiKey) {
      return NextResponse.json(
        { error: 'bid(JSON 문자열), prompt, geminiKey, files가 필요합니다.' },
        { status: 400 }
      );
    }

    if (!files || files.length === 0) {
      return NextResponse.json(
        { error: '분석할 첨부 파일을 하나 이상 업로드해 주세요.' },
        { status: 400 }
      );
    }

    const bid = JSON.parse(bidRaw) as Record<string, unknown> & { id?: string };
    const bidId = bid.id;

    if (!bidId) {
      return NextResponse.json({ error: 'bid.id가 필요합니다.' }, { status: 400 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json(
        { error: 'Supabase 환경 변수가 설정되지 않았습니다.' },
        { status: 500 }
      );
    }
    const supabase = createClient(supabaseUrl, supabaseKey);

    const parts: string[] = [];
    for (const file of files) {
      if (!(file instanceof File)) continue;
      const name = file.name ?? '';
      const lower = name.toLowerCase();
      if (!lower.endsWith('.pdf') && !lower.endsWith('.hwpx') && !lower.endsWith('.hwp')) continue;
      const buffer = Buffer.from(await file.arrayBuffer());
      let text = '';
      if (lower.endsWith('.pdf')) {
        text = await extractTextFromPdf(buffer);
      } else if (lower.endsWith('.hwpx')) {
        text = await extractTextFromHwpx(buffer);
      } else if (lower.endsWith('.hwp')) {
        text = await extractTextFromHwp(buffer);
      }
      if (text && text.trim().length > 0) {
        parts.push(`[${name}]\n${text.trim()}`);
      }
    }

    const documentText =
      parts.length === 0
        ? null
        : (() => {
            let combined = parts.join('\n\n---\n\n');
            if (combined.length > MAX_DOCUMENT_CHARS) {
              combined = combined.slice(0, MAX_DOCUMENT_CHARS) + '\n\n[... 이후 생략 ...]';
            }
            return combined;
          })();

    const summary = await callGemini(String(geminiKey), String(prompt), bid, documentText);

    const finalSummary = summary && summary.trim().length > 0 ? summary.trim() : '-';

    await supabase.from('ai_analysis_cache').upsert(
      { bid_id: bidId, summary: finalSummary },
      { onConflict: 'bid_id' }
    );

    const updatedBid = { ...bid, summary: finalSummary };

    return NextResponse.json({ bid: updatedBid });
  } catch (error) {
    console.error('analyze-upload API error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '서버 오류' },
      { status: 500 }
    );
  }
}


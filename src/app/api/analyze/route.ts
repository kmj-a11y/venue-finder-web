import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';

export const maxDuration = 60;

export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
};

export const MAX_DOCUMENT_CHARS = 15_000;

async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  const mod = await import('pdf-parse');
  const pdfParse = (mod as { default?: (buf: Buffer) => Promise<{ text?: string }> }).default ?? mod;
  const data = await pdfParse(buffer);
  const text = (data?.text ?? '').trim();
  if (!text || text.length < 50) {
    throw new Error('스캔된 문서이거나 텍스트를 추출할 수 없는 PDF 파일입니다.');
  }
  return text;
}

function normalizeHwpxXmlToText(xmlContent: string): string {
  return xmlContent
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(parseInt(dec, 10))
    )
    .replace(/\s+/g, ' ')
    .trim();
}

async function extractTextFromHwpx(buffer: Buffer): Promise<string> {
  const AdmZip = require('adm-zip');
  let zip: any;

  try {
    zip = new AdmZip(buffer);
  } catch (e: any) {
    const msg = String(e?.message ?? e ?? '').toLowerCase();
    if (msg.includes('zip') || msg.includes('header')) {
      throw new Error(
        '올바른 HWPX 파일이 아닙니다. (확장자만 임의로 변경했거나, 공공기관 DRM 보안이 걸린 파일입니다. PDF로 변환하여 업로드해주세요.)'
      );
    }
    throw e;
  }

  const entries = zip.getEntries() || [];

  const sectionEntries = entries.filter((e: any) => {
    const name = String(e.entryName || '').toLowerCase();
    return name.startsWith('contents/section') || name.startsWith('bodytext/section');
  });

  const xmlParts: string[] = [];

  if (sectionEntries.length > 0) {
    for (const entry of sectionEntries) {
      const xmlContent = entry.getData().toString('utf8');
      xmlParts.push(normalizeHwpxXmlToText(xmlContent));
    }
  } else {
    const fallbackEntry =
      zip.getEntry('Contents/section0.xml') || zip.getEntry('BodyText/Section0.xml');
    if (!fallbackEntry) {
      throw new Error('hwpx 문서에서 본문 섹션을 찾을 수 없습니다.');
    }
    const xml = fallbackEntry.getData().toString('utf8');
    xmlParts.push(normalizeHwpxXmlToText(xml));
  }

  const text = xmlParts.join(' ').trim();
  if (!text || text.length < 50) {
    throw new Error('스캔된 문서이거나 텍스트를 추출할 수 없는 hwpx 파일입니다.');
  }

  return text;
}

function buildMetadataBlock(bid: Record<string, unknown>): string {
  const title = bid.title ?? '-';
  const org = bid.org ?? '-';
  const budget = bid.budget ?? '-';
  const files = (bid.files as Array<{ name?: string }>) ?? [];
  const fileNames = files.map((f) => f?.name ?? '').filter(Boolean);
  const fileListText =
    fileNames.length > 0
      ? fileNames.map((name, i) => `  ${i + 1}. ${name}`).join('\n')
      : '(첨부파일 없음)';

  return `[공고 메타데이터]
- 공고명(제목): ${title}
- 수요기관: ${org}
- 배정예산: ${budget}
- 첨부파일 목록:
${fileListText}`;
}

async function callGeminiWithDocument(
  geminiKey: string,
  prompt: string,
  bid: Record<string, unknown>,
  documentText: string
): Promise<string> {
  try {
    const metadataBlock = buildMetadataBlock(bid);
    const truncatedDoc =
      documentText.length > MAX_DOCUMENT_CHARS
        ? documentText.slice(0, MAX_DOCUMENT_CHARS)
        : documentText;

    const fullPrompt = `${prompt}

---
다음은 해당 공고의 메타데이터와 첨부파일에서 추출한 원문 텍스트야. 이 내용을 모두 반영해서 분석해 줘.

${metadataBlock}

[문서 원문 추출 텍스트]
${truncatedDoc}`;

    const genAI = new GoogleGenerativeAI(String(geminiKey).trim());
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent(fullPrompt);
    const text = result.response?.text?.() ?? '';

    if (!text || typeof text !== 'string' || text.trim() === '') {
      throw new Error('Gemini 응답에서 요약 텍스트를 찾을 수 없습니다.');
    }

    return text.trim();
  } catch (error: any) {
    console.error('Gemini SDK Error Detail:', error, error?.cause);
    const baseMsg =
      error instanceof Error ? error.message : String(error ?? '알 수 없는 오류');
    const causeMsg =
      typeof error?.cause?.message === 'string'
        ? error.cause.message
        : '';
    const combined = causeMsg || baseMsg || '알 수 없는 네트워크/SDK 오류입니다.';
    throw new Error(`Gemini 통신 에러: ${combined}`);
  }
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const bidJson = formData.get('bid');
    const prompt = formData.get('prompt');
    const geminiKey = formData.get('geminiKey');

    if (!file) {
      throw new Error('분석할 파일이 전송되지 않았습니다.');
    }
    if (!bidJson) {
      throw new Error('bid 정보가 전송되지 않았습니다.');
    }
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('prompt가 비어 있습니다.');
    }
    if (!geminiKey || typeof geminiKey !== 'string' || !geminiKey.trim()) {
      throw new Error('Gemini API Key가 설정되지 않았습니다.');
    }

    let bid: Record<string, any>;
    try {
      bid = JSON.parse(String(bidJson));
    } catch {
      throw new Error('bid JSON 파싱에 실패했습니다.');
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const fileName = (file.name || '').trim();
    const lowerName = fileName.toLowerCase();

    if (lowerName.endsWith('.hwp')) {
      throw new Error('구형 .hwp 파일은 지원하지 않습니다. PDF나 .hwpx로 변환 후 업로드해주세요.');
    }

    let extractedText = '';

    if (lowerName.endsWith('.pdf')) {
      extractedText = await extractTextFromPdf(buffer);
    } else if (lowerName.endsWith('.hwpx')) {
      extractedText = await extractTextFromHwpx(buffer);
    } else {
      throw new Error('지원하지 않는 파일 형식입니다. .pdf 또는 .hwpx 파일만 업로드할 수 있습니다.');
    }

    if (!extractedText || extractedText.trim().length < 50) {
      throw new Error('스캔된 문서이거나 텍스트를 추출할 수 없는 파일입니다.');
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase 환경 변수가 설정되지 않았습니다.');
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const summary = await callGeminiWithDocument(
      String(geminiKey),
      String(prompt),
      bid,
      extractedText
    );

    const bidId = String(bid.id ?? '');
    if (bidId) {
      const { error: upsertError } = await supabase
        .from('ai_analysis_cache')
        .upsert({ bid_id: bidId, summary }, { onConflict: 'bid_id' });

      if (upsertError) {
        console.error('ai_analysis_cache upsert error:', upsertError);
      }
    }

    const updatedBid = {
      ...bid,
      summary,
    };

    return NextResponse.json({ bid: updatedBid });
  } catch (error) {
    console.error('analyze API error:', error);
    const message =
      error instanceof Error
        ? error.message
        : '파일 분석 중 알 수 없는 오류가 발생했습니다.';
    const isGeminiError = typeof message === 'string' && message.startsWith('Gemini 통신 에러');
    const status = isGeminiError ? 500 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

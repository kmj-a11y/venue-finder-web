import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import CloudConvert from 'cloudconvert';
import { AnalyzeError, classifyAnalyzeError } from '@/lib/analyzeErrors';

/** Vercel 서버리스 최대 실행 시간(초). CloudConvert·Gemini 등 장시간 작업 대비 */
export const maxDuration = 300;

export const MAX_DOCUMENT_CHARS = 15_000;

const cloudConvert = new CloudConvert(process.env.CLOUDCONVERT_API_KEY || '');

function isPaymentRequiredError(error: unknown): boolean {
  const e = error as {
    response?: { status?: number };
    status?: number;
    statusCode?: number;
    code?: number | string;
    message?: string;
  };
  if (e?.response?.status === 402 || e?.status === 402 || e?.statusCode === 402) return true;
  if (e?.code === 402 || e?.code === '402') return true;
  const msg = typeof e?.message === 'string' ? e.message : '';
  return /402|payment\s*required|payment_required/i.test(msg);
}

/** Gemini 호출에서 재시도 가능한 일시 오류인지 판별한다. (503, 429, 5xx, 네트워크 단절) */
function isRetryableError(error: unknown): boolean {
  const e = error as {
    response?: { status?: number };
    status?: number;
    statusCode?: number;
    code?: number | string;
    message?: string;
  };
  const msg = typeof e?.message === 'string' ? e.message : '';
  // 하루 한도·월 지출 한도·선불 잔액 소진은 몇 초 기다려도 안 풀리므로 재시도하지 않는다.
  if (/PerDay|per day|spending cap|prepayment/i.test(msg)) return false;
  const status = e?.response?.status ?? e?.status ?? e?.statusCode;
  if (status === 503 || status === 429 || status === 500 || status === 502 || status === 504) return true;
  if (e?.code === 'ECONNRESET' || e?.code === 'ETIMEDOUT' || e?.code === 'EAI_AGAIN') return true;
  return /503|502|504|UNAVAILABLE|high demand|Service Unavailable|Too Many Requests|rate limit/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Gemini 호출을 exponential backoff로 자동 재시도한다.
 * - 결제 에러(402)는 재시도 의미 없어 즉시 throw
 * - 재시도 불가 에러도 즉시 throw
 * - 재시도 가능 에러: 2초 → 5초 → 포기 (총 최대 3회 시도)
 */
async function retryWithBackoff<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (isPaymentRequiredError(err)) throw err;
      if (!isRetryableError(err)) throw err;
      if (attempt === maxAttempts) throw err;
      const waitMs = attempt === 1 ? 2000 : 5000;
      console.warn(`[retryWithBackoff] attempt ${attempt} 실패, ${waitMs}ms 후 재시도`);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

function normalizeHwpxXmlToMarkdown(xmlContent: string): string {
  // HWPX(= 내부 XML)에서 표/문단 구조를 최대한 보존하기 위해 마크다운 형태로 변환한다.
  return xmlContent
    .replace(/<\/hp:p>/gi, '\n') // 문단 끝을 줄바꿈으로 변경
    .replace(/<\/tc:cell>/gi, ' | ') // 표의 셀을 마크다운 구분자로 변경
    .replace(/<[^>]+>/g, '') // 나머지 찌꺼기 XML 태그 모두 제거
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec) =>
      String.fromCodePoint(parseInt(dec, 10))
    )
    .replace(/[ \t]+/g, ' ') // 다중 공백 정리
    .replace(/\n\s+\n/g, '\n\n') // 빈 줄 정리
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
      xmlParts.push(normalizeHwpxXmlToMarkdown(xmlContent));
    }
  } else {
    const fallbackEntry =
      zip.getEntry('Contents/section0.xml') || zip.getEntry('BodyText/Section0.xml');
    if (!fallbackEntry) {
      throw new Error('hwpx 문서에서 본문 섹션을 찾을 수 없습니다.');
    }
    const xml = fallbackEntry.getData().toString('utf8');
    xmlParts.push(normalizeHwpxXmlToMarkdown(xml));
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

function truncateDoc(documentText: string): string {
  return documentText.length > MAX_DOCUMENT_CHARS
    ? documentText.slice(0, MAX_DOCUMENT_CHARS)
    : documentText;
}

type ParsedDoc =
  | { kind: 'pdf'; fileName: string; pdfBase64: string }
  | { kind: 'text'; fileName: string; text: string };

/** 첨부 전체를 한 번에 교차 검증하도록 지시하는 프롬프트 (Gemini 1회 호출용) */
function buildCombinedAnalysisPrompt(
  userPrompt: string,
  bid: Record<string, unknown>,
  docs: ParsedDoc[]
): string {
  const metadataBlock = buildMetadataBlock(bid);
  const fileList = docs.map((d, i) => `${i + 1}. ${d.fileName}`).join('\n');

  return `${userPrompt}

---
다음은 해당 공고의 메타데이터와 첨부파일 ${docs.length}개 전체다. 첨부는 이 프롬프트 뒤에 문서명과 함께 차례로 붙어 있다.

[첨부 목록]
${fileList}

[분석 원칙]
- 모든 첨부를 처음부터 끝까지 읽고 서로 교차 검증해라. 한 문서에 없으면 다른 문서에서 반드시 찾아라.
- 한 문서에 '명시되지 않음'이어도 다른 문서에 정보가 있으면 있는 정보를 채택해라.
- 채용 인원은 각 문서에서 찾은 숫자를 논리적으로 합산해서 보여줘라.
- 면접전형 일정은 흩어진 단서(날짜, 월 등)가 있으면 모두 취합해라.
- PDF는 표/박스/레이아웃을 최대한 보존해 읽어라.

[출력 규칙]
- 서론/인사/제목(### 등) 없이 첫 줄부터 1번 항목으로 시작해라.
- 각 항목 사이에는 빈 줄을 1~2줄 넣어라.

${metadataBlock}`;
}

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

async function runGeminiGenerateParts(geminiKey: string, parts: GeminiPart[]): Promise<string> {
  try {
    const genAI = new GoogleGenerativeAI(String(geminiKey).trim());
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const result = await retryWithBackoff(() =>
      model.generateContent({
        contents: [{ role: 'user', parts }],
      } as any)
    );

    const text = result.response?.text?.() ?? '';
    if (!text || typeof text !== 'string' || text.trim() === '') {
      throw new Error('Gemini 응답에서 요약 텍스트를 찾을 수 없습니다.');
    }
    return text.trim();
  } catch (error: any) {
    console.error('Gemini SDK Error Detail:', error, error?.cause);
    // 원문 에러(상태 코드 포함)가 남아 있을 때 분류해야 정확하다.
    throw new AnalyzeError(classifyAnalyzeError(error));
  }
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const files = formData.getAll('files') as File[];
    const bidJson = formData.get('bid');
    const prompt = formData.get('prompt');
    const geminiKey = formData.get('geminiKey');

    if (!files || files.length === 0) {
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

    const parsedDocs: ParsedDoc[] = [];

    for (const file of files) {
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const fileName = String(file.name || '').trim();
      const lowerName = fileName.toLowerCase();

      if (lowerName.endsWith('.pdf')) {
        // PDF는 변환 없이 원본 그대로 inlineData로 Gemini에 전달한다.
        const pdfBase64 = buffer.toString('base64');
        if (!pdfBase64 || pdfBase64.length < 200) {
          throw new Error('PDF 파일을 처리할 수 없습니다. (base64 변환 실패)');
        }
        parsedDocs.push({
          kind: 'pdf',
          fileName: fileName || '(이름 없음)',
          pdfBase64,
        });
        continue;
      }

      // HWP/HWPX: CloudConvert가 HWP->PDF를 지원하지 않는 계정/플랜/설정이 있어
      // (This conversion type is not supported) PDF 변환 대신 "텍스트 추출" 경로를 사용한다.
      // - HWPX: 로컬에서 XML 기반 텍스트 추출 (크레딧 0)
      // - HWP : CloudConvert로 TXT 변환 (크레딧 사용은 HWP에만)
      if (lowerName.endsWith('.hwpx')) {
        const text = await extractTextFromHwpx(buffer);
        parsedDocs.push({ kind: 'text', fileName: fileName || '(이름 없음)', text: text.trim() });
        continue;
      }
      if (lowerName.endsWith('.hwp')) {
        const text = await extractTextFromLegacyHwp(buffer, fileName);
        parsedDocs.push({ kind: 'text', fileName: fileName || '(이름 없음)', text: text.trim() });
        continue;
      }

      // 지원하지 않는 확장자는 명시적으로 실패 처리 (크레딧 낭비/오동작 방지)
      throw new Error(
        `지원하지 않는 파일 형식입니다: ${fileName || '(이름 없음)'} (허용: .pdf, .hwp, .hwpx)`
      );
    }

    if (parsedDocs.length === 0) {
      throw new Error('문서에서 유효한 텍스트를 추출하지 못했습니다.');
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase 환경 변수가 설정되지 않았습니다.');
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const key = String(geminiKey);
    const userPrompt = String(prompt);

    // 첨부가 몇 개든 Gemini는 한 번만 호출한다.
    // (무료 한도가 '하루 요청 수' 기준이라, 파일별로 나눠 부르면 공고 몇 건에 한도가 바닥난다)
    const parts: GeminiPart[] = [{ text: buildCombinedAnalysisPrompt(userPrompt, bid, parsedDocs) }];
    for (const doc of parsedDocs) {
      if (doc.kind === 'pdf') {
        parts.push({ text: `[첨부 PDF: ${doc.fileName}]` });
        parts.push({ inlineData: { mimeType: 'application/pdf', data: doc.pdfBase64 } });
      } else {
        parts.push({ text: `[첨부 문서: ${doc.fileName}]\n${truncateDoc(doc.text)}` });
      }
    }
    const summary = await runGeminiGenerateParts(key, parts);

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
    // 원인별로 분류해 화면이 '분류 · 설명 · 해결 방법'으로 보여줄 수 있게 돌려준다.
    const failure = classifyAnalyzeError(error);
    return NextResponse.json(
      { error: `${failure.category}: ${failure.message}`, failure },
      { status: failure.httpStatus }
    );
  }
}

async function extractTextFromLegacyHwp(buffer: Buffer, fileName: string): Promise<string> {
  if (!process.env.CLOUDCONVERT_API_KEY) {
    throw new Error('CloudConvert API 키가 설정되지 않았습니다.');
  }

  let job = await cloudConvert.jobs.create({
    tasks: {
      'import-my-file': { operation: 'import/upload' },
      'convert-my-file': {
        operation: 'convert',
        input: 'import-my-file',
        input_format: 'hwp',
        output_format: 'txt',
      },
      'export-my-file': {
        operation: 'export/url',
        input: 'convert-my-file',
      },
    },
  });

  const uploadTask: any = job.tasks.find((task: any) => task.name === 'import-my-file');
  if (!uploadTask) throw new Error('업로드 태스크 생성 실패');
  await cloudConvert.tasks.upload(uploadTask, buffer, fileName);

  job = await cloudConvert.jobs.wait(job.id);

  const exportTask: any = job.tasks.find((task: any) => task.name === 'export-my-file');
  const fileUrl = exportTask?.result?.files?.[0]?.url;

  if (!fileUrl) throw new Error('HWP 변환 결과 URL을 찾을 수 없습니다.');

  const response = await fetch(fileUrl);
  const text = await response.text();
  return text;
}

// NOTE: HWP/HWPX → PDF 변환은 CloudConvert 계정/정책에 따라 미지원일 수 있어 현재 사용하지 않는다.

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import CloudConvert from 'cloudconvert';

/** Vercel 서버리스 최대 실행 시간(초). CloudConvert·Gemini 등 장시간 작업 대비 */
export const maxDuration = 60;

export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
};

export const MAX_DOCUMENT_CHARS = 15_000;

const cloudConvert = new CloudConvert(process.env.CLOUDCONVERT_API_KEY || '');

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

function buildPdfMapPhasePrompt(
  userPrompt: string,
  bid: Record<string, unknown>,
  fileName: string
): string {
  const metadataBlock = buildMetadataBlock(bid);

  return `${userPrompt}

---
다음은 해당 공고의 메타데이터와, 첨부파일 중 **하나의 PDF 파일**("${fileName}") 자체다.

[중요 — Map 단계(PDF)]
- 공고에는 다른 첨부파일이 더 있을 수 있으나, 지금은 이 PDF 파일("${fileName}")만 읽고 분석해라.
- PDF 내부의 표/박스/레이아웃을 최대한 보존해 읽고, 사용자가 요청한 형식(예: 1~6번 항목)에 맞춰 이 문서에 근거해 분석하라.
- 이 문서에만 없고 다른 문서에 있을 수 있는 정보는 '명시되지 않음' 등으로 명확히 표기하라.

${metadataBlock}

[첨부 PDF]
(PDF 파일이 inlineData로 함께 제공된다. 너는 이 PDF 내용을 직접 읽어야 한다.)`;
}

function buildSingleFileAnalysisPrompt(
  userPrompt: string,
  bid: Record<string, unknown>,
  documentText: string
): string {
  const metadataBlock = buildMetadataBlock(bid);
  const truncatedDoc = truncateDoc(documentText);

  return `${userPrompt}

---
다음은 해당 공고의 메타데이터와 첨부파일에서 추출한 원문 텍스트야. 이 내용을 모두 반영해서 분석해 줘.

${metadataBlock}

[문서 원문 추출 텍스트]
${truncatedDoc}`;
}

function buildMapPhasePrompt(
  userPrompt: string,
  bid: Record<string, unknown>,
  fileName: string,
  documentText: string
): string {
  const metadataBlock = buildMetadataBlock(bid);
  const truncatedDoc = truncateDoc(documentText);
  const labeled = `[문서명: ${fileName}]\n${truncatedDoc}`;

  return `${userPrompt}

---
다음은 해당 공고의 메타데이터와, 첨부파일 중 **하나의 파일**에서만 추출한 원문 텍스트다.

[중요 — Map 단계]
- 공고에는 다른 첨부파일이 더 있을 수 있으나, 지금은 이 파일("${fileName}")의 내용만 본다.
- 사용자가 요청한 형식(예: 1~6번 항목)에 맞춰 이 문서에 근거해 분석하라.
- 이 문서에만 없고 다른 문서에 있을 수 있는 정보는 '명시되지 않음' 등으로 명확히 표기하라.

${metadataBlock}

[문서 원문 추출 텍스트 — 단일 파일]
${labeled}`;
}

async function runGeminiGenerate(geminiKey: string, fullPrompt: string): Promise<string> {
  try {
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

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

async function runGeminiGenerateParts(geminiKey: string, parts: GeminiPart[]): Promise<string> {
  try {
    const genAI = new GoogleGenerativeAI(String(geminiKey).trim());
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const result = await model.generateContent({
      contents: [{ role: 'user', parts }],
    } as any);

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

async function callGeminiWithDocument(
  geminiKey: string,
  prompt: string,
  bid: Record<string, unknown>,
  documentText: string
): Promise<string> {
  const fullPrompt = buildSingleFileAnalysisPrompt(prompt, bid, documentText);
  return runGeminiGenerate(geminiKey, fullPrompt);
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

    type ParsedDoc =
      | { kind: 'pdf'; fileName: string; pdfBase64: string }
      | { kind: 'text'; fileName: string; text: string };

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

    let summary = '';

    // Map-Reduce 유지:
    // - 파일이 1개면 단일 호출로 비용/시간 절감
    // - 파일이 2개 이상이면 개별 분석(Map) 후 종합(Reduce)
    if (parsedDocs.length === 1) {
      const only = parsedDocs[0];
      if (only.kind === 'pdf') {
        const mapPrompt = buildPdfMapPhasePrompt(userPrompt, bid, only.fileName);
        summary = await runGeminiGenerateParts(key, [
          { text: mapPrompt },
          { inlineData: { mimeType: 'application/pdf', data: only.pdfBase64 } },
        ]);
      } else {
        const docBody = `[문서명: ${only.fileName}]\n${only.text}`;
        summary = await callGeminiWithDocument(key, userPrompt, bid, docBody);
      }
    } else {
      const mapResults: string[] = [];

      // 429 방지를 위해 순차 처리 + 2초 쿨타임
      for (const [i, doc] of parsedDocs.entries()) {
        if (i > 0) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }

        if (doc.kind === 'pdf') {
          const mapPrompt = buildPdfMapPhasePrompt(userPrompt, bid, doc.fileName);
          mapResults.push(
            await runGeminiGenerateParts(key, [
              { text: mapPrompt },
              { inlineData: { mimeType: 'application/pdf', data: doc.pdfBase64 } },
            ])
          );
        } else {
          const mapPrompt = buildMapPhasePrompt(userPrompt, bid, doc.fileName, doc.text);
          mapResults.push(await runGeminiGenerate(key, mapPrompt));
        }
      }

      const combinedIntermediate = mapResults
        .map((result, i) => `--- 문서 ${i + 1} 분석 결과 ---\n${result}`)
        .join('\n\n');

      // Reduce 단계는 1차 결과 텍스트들을 종합하는 "텍스트" 호출
      const reducePrompt = `${userPrompt}

---
너는 공공기관 입찰 분석 수석 컨설턴트야. 제공된 텍스트는 여러 첨부파일을 개별적으로 1차 분석한 결과물들이다. 이 결과들을 꼼꼼히 교차 검증해서, 누락된 정보 없이 완벽한 하나의 1~6번 항목으로 종합해라. 한 문서에서 '명시되지 않음'으로 나왔더라도 다른 문서에 정보가 있다면 무조건 있는 정보를 채택해라. 채용 인원의 경우 각 문서에서 찾은 숫자를 논리적으로 합산해서 보여줘. 3번 면접전형 일정은 흩어진 단서(날짜, 월 등)가 있다면 모두 취합해.

[출력 규칙]
- 서론/인사/제목(### 등) 없이 첫 줄부터 1번 항목으로 시작해라.
- 1~6번 각 항목 사이에는 빈 줄을 1~2줄 넣어라.

[개별 문서별 1차 분석 결과]
${combinedIntermediate}`;

      summary = await runGeminiGenerate(key, reducePrompt);
    }

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

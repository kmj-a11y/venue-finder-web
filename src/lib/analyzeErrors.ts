// AI 분석 실패 원인을 분류해 사람이 읽을 수 있는 설명·해결 방법으로 바꾸는 규칙 모음

export type AnalyzeFailure = {
  /** 분류 코드 (로그·조건 분기용) */
  code: string;
  /** 화면에 굵게 보이는 분류명 */
  category: string;
  /** 무슨 일이 있었는지 */
  message: string;
  /** 사용자가 할 일 */
  action: string;
  /** 서버가 돌려줄 HTTP 상태 */
  httpStatus: number;
  /** 원문 에러 (일부만, 디버깅용) */
  detail?: string;
};

/** 분류가 끝난 에러. 서버에서 throw → 최상위 catch에서 그대로 응답으로 쓴다. */
export class AnalyzeError extends Error {
  failure: AnalyzeFailure;
  constructor(failure: AnalyzeFailure) {
    super(`${failure.category}: ${failure.message}`);
    this.name = 'AnalyzeError';
    this.failure = failure;
  }
}

function rawTextOf(err: unknown): string {
  const e = err as { message?: unknown; cause?: { message?: unknown } } | null;
  const parts = [e?.message, e?.cause?.message].filter((v) => typeof v === 'string') as string[];
  if (parts.length === 0) parts.push(String(err ?? ''));
  return parts.join(' | ');
}

function statusOf(err: unknown, text: string): number | undefined {
  const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown }; cause?: { status?: unknown } } | null;
  const candidates = [e?.status, e?.statusCode, e?.response?.status, e?.cause?.status];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  // Gemini SDK 메시지 형식: "...: [429 Too Many Requests] ..."
  const m = text.match(/\[(\d{3})\s[A-Za-z ]+\]/);
  return m ? Number(m[1]) : undefined;
}

/** "Please retry in 17h37m52.8s" / "retryDelay":"63472s" / "retry in 34.5s" → 초 */
export function parseRetrySeconds(text: string): number | null {
  const hms = text.match(/retry in\s+(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i);
  if (hms && (hms[1] || hms[2] || hms[3])) {
    return Number(hms[1] ?? 0) * 3600 + Number(hms[2] ?? 0) * 60 + Math.ceil(Number(hms[3] ?? 0));
  }
  const delay = text.match(/retryDelay"?\s*:\s*"?(\d+)s/i);
  return delay ? Number(delay[1]) : null;
}

/** 다시 시도 가능한 시각을 한국 시간으로 안내 */
export function describeRetryTime(seconds: number, now: Date = new Date()): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.ceil((seconds % 3600) / 60);
  const span = h > 0 ? `약 ${h}시간 ${m}분 뒤` : `약 ${Math.max(m, 1)}분 뒤`;
  const at = new Date(now.getTime() + seconds * 1000).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${span} (${at} 이후)`;
}

function shorten(text: string, max = 300): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 서버에서 잡힌 모든 에러를 분류한다. */
export function classifyAnalyzeError(err: unknown, now: Date = new Date()): AnalyzeFailure {
  if (err instanceof AnalyzeError) return err.failure;

  const text = rawTextOf(err);
  const status = statusOf(err, text);
  const detail = shorten(text);

  if (/monthly spending cap|spend cap/i.test(text)) {
    return {
      code: 'GEMINI_SPEND_CAP',
      category: 'AI 월 지출 한도 도달',
      message: '이 API 키의 Google 계정에 설정된 월 지출 한도에 도달했습니다.',
      action: 'AI Studio(ai.studio/spend)에서 한도를 확인하세요. 매월 1일(미국 시간)에 초기화됩니다.',
      httpStatus: 429,
      detail,
    };
  }

  if (/prepayment credits are depleted|prepay/i.test(text)) {
    return {
      code: 'GEMINI_PREPAY_EMPTY',
      category: 'AI 선불 잔액 소진',
      message: '이 API 키의 Google 계정이 선불 결제 방식인데 충전 잔액이 0원입니다.',
      action: 'AI Studio에서 잔액을 충전하거나, 결제 정보가 없는 무료 계정의 API 키로 바꿔 주세요.',
      httpStatus: 429,
      detail,
    };
  }

  if (status === 429 || /Too Many Requests|RESOURCE_EXHAUSTED|quota/i.test(text)) {
    if (/PerDay|per day/i.test(text)) {
      const limit = text.match(/limit:\s*(\d+)/i)?.[1];
      const retry = parseRetrySeconds(text);
      return {
        code: 'GEMINI_DAILY_QUOTA',
        category: 'AI 하루 무료 한도 초과',
        message: `오늘 쓸 수 있는 Gemini 무료 분석 횟수${limit ? `(하루 ${limit}회)` : ''}를 모두 썼습니다.`,
        action: retry != null ? `${describeRetryTime(retry, now)} 다시 시도하세요.` : '내일 다시 시도하세요.',
        httpStatus: 429,
        detail,
      };
    }
    return {
      code: 'GEMINI_RATE_LIMIT',
      category: 'AI 분당 요청 한도 초과',
      message: '짧은 시간에 요청이 몰려 분당 한도에 걸렸습니다. 자동 재시도로도 풀리지 않았습니다.',
      action: '1~2분 뒤 다시 시도하세요.',
      httpStatus: 429,
      detail,
    };
  }

  if (/API key not valid|API_KEY_INVALID|API key expired|PERMISSION_DENIED/i.test(text) || status === 401 || status === 403) {
    return {
      code: 'GEMINI_KEY',
      category: 'API 키 오류',
      message: 'Gemini API 키가 잘못됐거나 사용할 수 없는 상태입니다.',
      action: '시스템 설정에서 API 키를 다시 붙여넣고 전체 저장을 눌러 주세요.',
      httpStatus: 400,
      detail,
    };
  }

  if (/exceeds the maximum|token count|payload size|request entity too large|too large/i.test(text)) {
    return {
      code: 'DOC_TOO_LARGE',
      category: '문서 분량 초과',
      message: '첨부 문서 분량이 AI가 한 번에 읽을 수 있는 양을 넘었습니다.',
      action: '공고문·제안요청서·과업지시서 같은 핵심 문서만 골라 다시 분석하세요.',
      httpStatus: 400,
      detail,
    };
  }

  if (
    status === 500 || status === 502 || status === 503 || status === 504 ||
    /high demand|overloaded|UNAVAILABLE|Service Unavailable|Internal Server Error/i.test(text)
  ) {
    return {
      code: 'GEMINI_BUSY',
      category: 'Google AI 서버 혼잡',
      message: 'Google AI 서버가 혼잡해 응답하지 않았습니다. 자동 재시도 3회도 실패했습니다. 우리 쪽 설정 문제는 아닙니다.',
      action: '몇 분 뒤 다시 시도하세요.',
      httpStatus: 503,
      detail,
    };
  }

  if (/요약 텍스트를 찾을 수 없습니다|SAFETY|blocked/i.test(text)) {
    return {
      code: 'GEMINI_EMPTY',
      category: 'AI 응답 없음',
      message: 'AI가 분석 결과 없이 빈 응답을 보냈습니다.',
      action: '다시 시도하세요. 같은 공고에서 반복되면 첨부 문서를 바꿔 보세요.',
      httpStatus: 502,
      detail,
    };
  }

  if (status === 402 || /payment\s*required|payment_required|credits/i.test(text)) {
    return {
      code: 'HWP_CONVERT_CREDIT',
      category: 'HWP 변환 사용량 소진',
      message: 'HWP 변환 서비스(CloudConvert)의 무료 사용량을 다 썼습니다.',
      action: "HWP를 PDF로 바꿔 올리거나, '선택 공고 다운로드 + PDF 변환'으로 받은 PDF를 쓰세요.",
      httpStatus: 402,
      detail,
    };
  }

  if (/HWPX|hwpx|스캔된 문서|PDF 파일을 처리할 수 없습니다|지원하지 않는 파일 형식|텍스트를 추출하지 못했습니다|DRM|HWP 변환|CloudConvert|업로드 태스크/i.test(text)) {
    return {
      code: 'FILE_READ',
      category: '첨부파일 읽기 실패',
      message: rawTextOf(err).replace(/^Error:\s*/, ''),
      action: '한글에서 PDF로 저장해 다시 올려 주세요.',
      httpStatus: 400,
      detail,
    };
  }

  if (/환경 변수|API Key가 설정되지|prompt가 비어|파일이 전송되지|bid 정보|bid JSON/i.test(text)) {
    return {
      code: 'INPUT',
      category: '분석 설정 누락',
      message: rawTextOf(err).replace(/^Error:\s*/, ''),
      action: '시스템 설정의 API 키·프롬프트를 확인하고 파일을 다시 선택해 주세요.',
      httpStatus: 400,
      detail,
    };
  }

  if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network/i.test(text)) {
    return {
      code: 'NETWORK',
      category: 'Google 연결 실패',
      message: '분석 서버에서 Google AI로 연결하지 못했습니다.',
      action: '잠시 후 다시 시도하세요.',
      httpStatus: 502,
      detail,
    };
  }

  return {
    code: 'UNKNOWN',
    category: '알 수 없는 오류',
    message: '예상하지 못한 오류가 발생했습니다.',
    action: '아래 원문을 캡처해 두고 다시 시도해 보세요.',
    httpStatus: 500,
    detail,
  };
}

/** 서버까지 못 가고 Vercel/브라우저에서 막힌 경우 (응답이 JSON이 아닐 때) */
export function classifyHttpFailure(status: number): AnalyzeFailure {
  if (status === 413) {
    return {
      code: 'UPLOAD_TOO_BIG',
      category: '파일 용량 초과',
      message: '올린 파일의 합계 용량이 너무 큽니다. 분석 서버(Vercel)는 한 번에 약 4.5MB까지만 받습니다.',
      action: '파일 수를 줄이거나 공고문·제안요청서·과업지시서 같은 핵심 문서만 올려 주세요.',
      httpStatus: 413,
    };
  }
  if (status === 504) {
    return {
      code: 'TIMEOUT',
      category: '분석 시간 초과',
      message: '분석이 너무 오래 걸려 서버가 중간에 멈췄습니다(최대 5분).',
      action: '파일 수를 줄여 다시 시도하세요.',
      httpStatus: 504,
    };
  }
  return {
    code: 'SERVER_DOWN',
    category: '분석 서버 연결 실패',
    message: `분석 서버(Vercel)가 정상 응답을 주지 않았습니다(HTTP ${status}).`,
    action: '잠시 후 다시 시도하세요.',
    httpStatus: status,
  };
}

/** 브라우저에서 요청 자체가 실패했을 때 (인터넷 끊김 등) */
export const OFFLINE_FAILURE: AnalyzeFailure = {
  code: 'OFFLINE',
  category: '인터넷 연결 실패',
  message: '분석 서버에 요청을 보내지 못했습니다.',
  action: '인터넷 연결을 확인하고 다시 시도하세요.',
  httpStatus: 0,
};

/** 화면의 '과업 내용 상세정리' 칸에 넣을 실패 문구 */
export function formatFailureSummary(f: AnalyzeFailure): string {
  const lines = [`⚠️ 분석 실패 · **${f.category}**`, f.message, `→ ${f.action}`];
  if (f.code === 'UNKNOWN' && f.detail) lines.push('', `(원문: ${f.detail})`);
  return lines.join('\n');
}

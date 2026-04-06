import { NextResponse } from 'next/server';
import * as cheerio from 'cheerio';

/** Vercel 서버리스 최대 실행 시간(초). 상세·첨부 스크래핑 지연 대비 */
export const maxDuration = 60;

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

type Attachment = { name: string; url: string; source: 'file' | 'proposal' };

type KUploadFile = {
  name: string;
  url: string;
  untyAtchFileNo?: string;
  atchFileSqno?: string | number;
  bidPbancNo?: string;
  bidPbancOrd?: string;
  fileSeq?: string | number;
  bsnePath?: string;
  tblNm?: string;
};

function absolutize(url: string): string {
  const u = url.trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('//')) return `https:${u}`;
  if (u.startsWith('/')) return `https://www.g2b.go.kr${u}`;
  return u;
}

function uniqAttachments(files: Attachment[]): Attachment[] {
  const seen = new Set<string>();
  const out: Attachment[] = [];
  for (const f of files) {
    const key = `${f.name}||${f.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function pickCookies(setCookieHeader: string | null): string {
  if (!setCookieHeader) return '';
  // Next.js/undici may join multiple Set-Cookie headers into one string.
  // Take only key=value segments (drop attributes).
  return setCookieHeader
    .split(/,(?=\s*[^;]+=[^;]+)/g)
    .map((c) => c.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

function mergeCookieStrings(a: string, b: string): string {
  const map = new Map<string, string>();
  const ingest = (s: string) => {
    for (const part of String(s || '').split(';')) {
      const t = part.trim();
      if (!t) continue;
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim();
      if (!k) continue;
      map.set(k, v);
    }
  };
  ingest(a);
  ingest(b);
  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function extractUuidCandidatesFromHtml(html: string): string[] {
  const uuidRe =
    /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
  const all = html.match(uuidRe) ?? [];
  // Deduplicate, but keep stable-ish order
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of all) {
    const key = u.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
}

function extractBsneClsfCdFromHtml(html: string): string | null {
  // e.g. "bsneClsfCd":"업130020"
  const m = html.match(/["']bsneClsfCd["']\s*:\s*["']([^"']+)["']/);
  if (m?.[1]) return String(m[1]).trim();
  return null;
}

function extractBfSpecRegNoFromHtml(html: string): string | null {
  // e.g. R26BD00196101
  // 나라장터 페이지 내 JS/hidden input/inline JSON 등에 섞여 있는 값을 정규식으로 잡는다.
  const m = html.match(/\bR\d{2}BD\d{8,}\b/);
  if (m?.[0]) return String(m[0]).trim();
  // e.g. /link/PRVA004_02/?bfSpecRegNo=R26BD00196101
  const mLink = html.match(/PRVA004_02\/\?bfSpecRegNo=([A-Za-z0-9_-]+)/);
  if (mLink?.[1]) return String(mLink[1]).trim();
  const m2 = html.match(/["']bfSpecRegNo["']\s*[:=]\s*["']([^"']+)["']/i);
  if (m2?.[1]) return String(m2[1]).trim();
  return null;
}

async function fetchPbocSinglePage(
  bidNo: string,
  bidOrd: string
): Promise<string | null> {
  // HTTPS 443로 접근 가능한 링크 페이지(세부 정보/연계 파라미터가 포함되는 경우가 많음)
  const ord3 = String(bidOrd || '').padStart(3, '0');
  const url = new URL('https://www.g2b.go.kr/link/PBOC006_01/single/');
  url.searchParams.set('bidPbancNo', bidNo);
  url.searchParams.set('bidPbancOrd', ord3);
  url.searchParams.set('pbancType', 'pbanc');

  try {
    const res = await fetch(url.toString(), {
      cache: 'no-store',
      next: { revalidate: 0 },
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const html = await res.text();
    if (!res.ok || !html || html.length < 200) return null;
    return html;
  } catch {
    return null;
  }
}

function deepCollectObjects(value: any, out: any[]) {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const v of value) deepCollectObjects(v, out);
    return;
  }
  if (typeof value === 'object') {
    out.push(value);
    for (const v of Object.values(value)) deepCollectObjects(v, out);
  }
}

/** 통합첨부 순번·fileSeq가 0일 때 JS truthy 검사로 URL이 빠지는 것을 막는다 */
function isPresentId(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'number') return Number.isFinite(v);
  return true;
}

function padBidPbancOrd(ord: string): string {
  const d = String(ord ?? '').replace(/\D/g, '');
  const n = d.length ? d : '0';
  return n.padStart(3, '0').slice(-3);
}

function buildDownloadUrlFromKUploadRow(row: any, fallback: Partial<KUploadFile>): string {
  const untyAtchFileNo =
    row?.untyAtchFileNo ?? row?.UNTY_ATCH_FILE_NO ?? fallback.untyAtchFileNo ?? '';
  const atchFileSqno =
    row?.atchFileSqno ??
    row?.atchFileSqNo ??
    row?.ATCH_FILE_SQNO ??
    row?.atchFileSeqNo ??
    row?.atchFileSeqno ??
    row?.fileSqno ??
    fallback.atchFileSqno ??
    '';

  const bidPbancNo = row?.bidPbancNo ?? row?.bidPbancNoVal ?? fallback.bidPbancNo ?? '';
  const bidPbancOrd = row?.bidPbancOrd ?? fallback.bidPbancOrd ?? '';
  const fileSeq = row?.fileSeq ?? row?.fileSn ?? row?.atchFileSn ?? fallback.fileSeq ?? '';

  // 1) If bidPbancNo + fileSeq is present, use the public PNPE download endpoint.
  if (bidPbancNo && isPresentId(fileSeq)) {
    const bsnePath = String(fallback.bsnePath ?? 'PNPE').toLowerCase();
    return absolutize(
      `/pn/pnp/${bsnePath}/UntyAtchFile/downloadFile.do?bidPbancNo=${encodeURIComponent(
        String(bidPbancNo)
      )}&bidPbancOrd=${encodeURIComponent(String(bidPbancOrd || '000'))}&fileSeq=${encodeURIComponent(
        String(fileSeq)
      )}&fileType=`
    );
  }

  // 2) Else prefer the FSC download endpoint (commonly used by KUpload).
  if (untyAtchFileNo && isPresentId(atchFileSqno)) {
    const key = row?.key ?? row?.dlKey ?? row?.downloadKey ?? row?.KEY ?? '';
    const base = `/fs/fsc/fscb/UntyAtchFile/downloadUntyAtchFileWithInfo.do?untyAtchFileNo=${encodeURIComponent(
      String(untyAtchFileNo)
    )}&atchFileSqno=${encodeURIComponent(String(atchFileSqno))}`;
    return absolutize(key ? `${base}&key=${encodeURIComponent(String(key))}` : base);
  }

  return '';
}

async function fetchBfSpecDetail(
  apiKey: { cookie: string; referer: string },
  bfSpecRegNo: string
): Promise<any | null> {
  const res = await fetch('https://www.g2b.go.kr/pn/pnz/pnza/BfSpec/selectBfSpec.do', {
    method: 'POST',
    cache: 'no-store',
    next: { revalidate: 0 },
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://www.g2b.go.kr',
      Referer: apiKey.referer,
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari',
      ...(apiKey.cookie ? { Cookie: apiKey.cookie } : {}),
    },
    body: JSON.stringify({
      dlParamM: { bfSpecRegNo, prcmBsneSeCd: '', opnnSqno: '', jobType: '' },
    }),
  });

  const text = await res.text();
  if (!res.ok) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function warmupPrvaPageForBfSpec(
  bfSpecRegNo: string
): Promise<{ cookie: string; referer: string } | null> {
  // PRVA 링크 페이지를 한 번 밟아 세션/쿠키를 확보 (BfSpec XHR이 쿠키를 요구하는 케이스 대응)
  const url = new URL('https://www.g2b.go.kr/link/PRVA004_02/');
  url.searchParams.set('bfSpecRegNo', bfSpecRegNo);

  try {
    const res = await fetch(url.toString(), {
      cache: 'no-store',
      next: { revalidate: 0 },
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const html = await res.text();
    if (!res.ok || !html || html.length < 100) return null;
    const cookie = pickCookies(res.headers.get('set-cookie'));
    return { cookie, referer: url.toString() };
  } catch {
    return null;
  }
}

async function fetchPrvaPageHtml(bfSpecRegNo: string): Promise<string | null> {
  const url = new URL('https://www.g2b.go.kr/link/PRVA004_02/');
  url.searchParams.set('bfSpecRegNo', bfSpecRegNo);
  try {
    const res = await fetch(url.toString(), {
      cache: 'no-store',
      next: { revalidate: 0 },
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const html = await res.text();
    if (!res.ok || !html || html.length < 200) return null;
    return html;
  } catch {
    return null;
  }
}

async function fetchBfSpecDetailRaw(
  apiKey: { cookie: string; referer: string },
  bfSpecRegNo: string
): Promise<{ status: number; text: string; json: any | null }> {
  const res = await fetch('https://www.g2b.go.kr/pn/pnz/pnza/BfSpec/selectBfSpec.do', {
    method: 'POST',
    cache: 'no-store',
    next: { revalidate: 0 },
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://www.g2b.go.kr',
      Referer: apiKey.referer,
      'X-Requested-With': 'XMLHttpRequest',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari',
      ...(apiKey.cookie ? { Cookie: apiKey.cookie } : {}),
    },
    body: JSON.stringify({
      dlParamM: { bfSpecRegNo, prcmBsneSeCd: '', opnnSqno: '', jobType: '' },
    }),
  });

  const text = await res.text();
  let json: any | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

function extractFirstUuidNearKey(html: string, key: string): string | null {
  // Find a uuid near a given key name (e.g. "untyAtchFileNo")
  const idx = html.toLowerCase().indexOf(key.toLowerCase());
  if (idx < 0) return null;
  const window = html.slice(Math.max(0, idx - 300), Math.min(html.length, idx + 800));
  const m =
    window.match(
      /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/
    ) ?? null;
  return m?.[0] ? String(m[0]).trim() : null;
}

function extractAllUntyAtchFileNosFromHtml(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const re = /untyAtchFileNo\s*["']?\s*[:=]\s*["']([0-9a-fA-F-]{36})["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const u = String(m[1] || '').trim();
    if (!u) continue;
    const k = u.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(u);
  }

  const re2 = /UNTY_ATCH_FILE_NO\s*["']?\s*[:=]\s*["']([0-9a-fA-F-]{36})["']/gi;
  while ((m = re2.exec(html))) {
    const u = String(m[1] || '').trim();
    if (!u) continue;
    const k = u.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(u);
  }

  // Fallback: if none, pick a UUID near the key.
  if (out.length === 0) {
    const near = extractFirstUuidNearKey(html, 'untyAtchFileNo');
    if (near) out.push(near);
  }

  return out;
}

function pickBestUuidFromHtml(html: string): string | null {
  const uuids = extractUuidCandidatesFromHtml(html);
  if (uuids.length === 0) return null;
  if (uuids.length === 1) return uuids[0];

  // Score by proximity to attachment-related keywords.
  const lower = html.toLowerCase();
  const keywords = ['untyatch', 'atchfile', 'pbanc_bf_spec', 'dluntyatchfile', 'kupload'];
  const scoreOf = (u: string) => {
    const idx = lower.indexOf(u.toLowerCase());
    if (idx < 0) return 0;
    const w = lower.slice(Math.max(0, idx - 1200), Math.min(lower.length, idx + 1200));
    let s = 1;
    for (const k of keywords) if (w.includes(k)) s += 3;
    if (w.includes('untyatchfileno')) s += 5;
    return s;
  };

  return uuids
    .map((u) => ({ u, s: scoreOf(u) }))
    .sort((a, b) => b.s - a.s)
    .at(0)?.u ?? uuids[0];
}

async function warmupRoot(): Promise<string> {
  try {
    const res = await fetch('https://www.g2b.go.kr/', {
      cache: 'no-store',
      next: { revalidate: 0 },
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    return pickCookies(res.headers.get('set-cookie'));
  } catch {
    return '';
  }
}

async function warmupBfSpecModulePage(
  bfSpecRegNo: string,
  cookie: string
): Promise<{ ok: boolean; url: string | null; cookie: string }> {
  const candidates = [
    `https://www.g2b.go.kr/pn/pnz/pnza/BfSpec/bfSpec.do?bfSpecRegNo=${encodeURIComponent(bfSpecRegNo)}`,
    `https://www.g2b.go.kr/pn/pnz/pnza/BfSpec/bfSpecDetail.do?bfSpecRegNo=${encodeURIComponent(bfSpecRegNo)}`,
    `https://www.g2b.go.kr/pn/pnz/pnza/BfSpec/bfSpecView.do?bfSpecRegNo=${encodeURIComponent(bfSpecRegNo)}`,
  ];

  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        cache: 'no-store',
        next: { revalidate: 0 },
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          ...(cookie ? { Cookie: cookie } : {}),
        },
      });
      const text = await res.text();
      const setCookie = pickCookies(res.headers.get('set-cookie'));
      const merged = setCookie ? mergeCookieStrings(cookie, setCookie) : cookie;
      if (res.ok && text && text.length > 200) {
        return { ok: true, url, cookie: merged };
      }
      cookie = merged;
    } catch {
      // continue
    }
  }

  return { ok: false, url: null, cookie };
}

async function fetchKUploadFileList(
  apiKey: { cookie: string; referer: string },
  body: Record<string, unknown>
): Promise<any | null> {
  const res = await fetch(
    'https://www.g2b.go.kr/fs/fsc/fscb/UntyAtchFile/selectUntyAtchFileList.do',
    {
      method: 'POST',
      cache: 'no-store',
      next: { revalidate: 0 },
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        Accept: 'application/json, text/plain, */*',
        Origin: 'https://www.g2b.go.kr',
        Referer: apiKey.referer,
        'X-Requested-With': 'XMLHttpRequest',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari',
        ...(apiKey.cookie ? { Cookie: apiKey.cookie } : {}),
      },
      body: JSON.stringify(body),
    }
  );

  const text = await res.text();
  if (!res.ok) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fetchKUploadFileListWithDebug(
  apiKey: { cookie: string; referer: string },
  body: Record<string, unknown>
): Promise<{ status: number; text: string; json: any | null }> {
  const res = await fetch(
    'https://www.g2b.go.kr/fs/fsc/fscb/UntyAtchFile/selectUntyAtchFileList.do',
    {
      method: 'POST',
      cache: 'no-store',
      next: { revalidate: 0 },
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        Accept: 'application/json, text/plain, */*',
        Origin: 'https://www.g2b.go.kr',
        Referer: apiKey.referer,
        'X-Requested-With': 'XMLHttpRequest',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari',
        ...(apiKey.cookie ? { Cookie: apiKey.cookie } : {}),
      },
      body: JSON.stringify(body),
    }
  );

  const text = await res.text();
  let json: any | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

async function fetchProposalFilesViaPlaywright(args: {
  bidNo: string;
  bidOrd: string;
  bfSpecRegNo?: string | null;
  bsneClsfCdFallback: string;
}): Promise<Attachment[]> {
  const pbFb: Partial<KUploadFile> = {
    bidPbancNo: args.bidNo,
    bidPbancOrd: padBidPbancOrd(args.bidOrd),
  };
  // Headless browser fallback for cases where Step1(selectBfSpec) is forbidden server-side (-801),
  // but the browser UI can still retrieve the UUID and attachment list.
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari',
    locale: 'ko-KR',
  });
  const page = await context.newPage();

  const bidOrd2 = String(args.bidOrd || '').padStart(2, '0');
  const detailUrl = `https://www.g2b.go.kr/ep/invitation/publish/bidInfoDtl.do?bidno=${encodeURIComponent(
    args.bidNo
  )}&bidseq=${encodeURIComponent(bidOrd2)}&releaseYn=Y&taskClCd=1`;
  const prvaUrl = args.bfSpecRegNo
    ? `https://www.g2b.go.kr/link/PRVA004_02/?bfSpecRegNo=${encodeURIComponent(
        String(args.bfSpecRegNo)
      )}`
    : null;

  let untyAtchFileNo: string | null = null;
  let bsneClsfCd: string | null = null;
  let gotListJson: any | null = null;
  let gotListReferer: string | null = null;
  let discoveredBfSpecRegNo: string | null = null;

  // Capture the Step1 response if it happens in the page.
  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      if (url.includes('/pn/pnz/pnza/BfSpec/selectBfSpec.do')) {
        const txt = await resp.text();
        const json = JSON.parse(txt);
        const dlBfSpecM =
          json?.dlBfSpecM ??
          json?.data?.dlBfSpecM ??
          json?.result?.dlBfSpecM ??
          json?.response?.dlBfSpecM ??
          null;
        const u = String(dlBfSpecM?.untyAtchFileNo ?? '').trim();
        const c = String(dlBfSpecM?.bsneClsfCd ?? '').trim();
        if (u) untyAtchFileNo = u;
        if (c) bsneClsfCd = c;
        return;
      }

      // If the page itself calls Step2, capture the list response directly.
      if (url.includes('/fs/fsc/fscb/UntyAtchFile/selectUntyAtchFileList.do')) {
        const txt = await resp.text();
        const json = JSON.parse(txt);
        gotListJson = json;
        gotListReferer = resp.request().url();
        return;
      }

      // Generic discovery: some pages return bfSpecRegNo/untyAtchFileNo in other XHR responses.
      if (!args.bfSpecRegNo && !discoveredBfSpecRegNo && !untyAtchFileNo) {
        const ct = (resp.headers()['content-type'] || '').toLowerCase();
        if (ct.includes('json')) {
          const txt = await resp.text();
          if (txt && txt.length < 900_000) {
            const bf = txt.match(/\bR\d{2}BD\d{8,}\b/);
            if (bf?.[0]) discoveredBfSpecRegNo = bf[0];
            const u =
              txt.match(
                /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/
              )?.[0] ?? null;
            // don't blindly accept any uuid; only when key appears nearby
            if (!untyAtchFileNo && txt.toLowerCase().includes('untyatchfileno') && u) {
              untyAtchFileNo = u;
            }
          }
        }
      }
    } catch {
      // ignore
    }
  });

  // Navigate and give the page time to fire its XHRs.
  // Prefer PRVA page when bfSpecRegNo is known; otherwise use bid detail page.
  await page.goto(prvaUrl ?? detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // allow XHR to finish
  await page.waitForTimeout(3500);

  // If Step2 list was already captured, use it directly.
  if (gotListJson) {
    const normalized = normalizeKUploadFilesFromResponse(gotListJson, {
      bsnePath: 'PRVA',
      tblNm: 'PBANC_BF_SPEC',
      ...pbFb,
    });
    await browser.close();
    return normalized.map((f) => ({ name: f.name, url: f.url, source: 'proposal' as const }));
  }

  // If XHR didn't fire or wasn't captured, try extracting from DOM text.
  let content = await page.content();

  // If we started from the detail page (bfSpecRegNo unknown), try to discover bfSpecRegNo
  // then revisit PRVA page to trigger proper XHRs.
  if (!args.bfSpecRegNo) {
    const discovered = discoveredBfSpecRegNo || extractBfSpecRegNoFromHtml(content);
    if (discovered) {
      const prva2 = `https://www.g2b.go.kr/link/PRVA004_02/?bfSpecRegNo=${encodeURIComponent(
        discovered
      )}`;
      await page.goto(prva2, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2500);

      if (gotListJson) {
        const normalized = normalizeKUploadFilesFromResponse(gotListJson, {
          bsnePath: 'PRVA',
          tblNm: 'PBANC_BF_SPEC',
          ...pbFb,
        });
        await browser.close();
        return normalized.map((f) => ({ name: f.name, url: f.url, source: 'proposal' as const }));
      }

      content = await page.content();
    }
  }
  if (!untyAtchFileNo) {
    const u = extractAllUntyAtchFileNosFromHtml(content)[0] ?? null;
    if (u) untyAtchFileNo = u;
  }
  if (!bsneClsfCd) {
    bsneClsfCd = extractBsneClsfCdFromHtml(content) ?? null;
  }
  if (!bsneClsfCd) bsneClsfCd = args.bsneClsfCdFallback;

  if (!untyAtchFileNo) {
    await browser.close();
    return [];
  }

  // Step2 via Playwright request context (cookies automatically included).
  const payload = {
    dlUntyAtchFileM: { untyAtchFileNo, bsnePath: 'PRVA' },
    bsneClsfCd,
    bsnePath: 'PRVA',
    colNm: 'UNTY_ATCH_FILE_NO',
    tblNm: 'PBANC_BF_SPEC',
    untyAtchFileNo,
  };

  const resp = await context.request.post(
    'https://www.g2b.go.kr/fs/fsc/fscb/UntyAtchFile/selectUntyAtchFileList.do',
    {
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        Accept: 'application/json, text/plain, */*',
        Origin: 'https://www.g2b.go.kr',
        Referer: prvaUrl ?? detailUrl,
        'X-Requested-With': 'XMLHttpRequest',
      },
      data: payload,
      timeout: 30000,
    }
  );

  let json: any = null;
  try {
    json = await resp.json();
  } catch {
    json = null;
  }

  const normalized = normalizeKUploadFilesFromResponse(json, {
    untyAtchFileNo,
    bsnePath: 'PRVA',
    tblNm: 'PBANC_BF_SPEC',
    ...pbFb,
  });

  await browser.close();
  return normalized.map((f) => ({ name: f.name, url: f.url, source: 'proposal' as const }));
}

function normalizeKUploadFilesFromResponse(
  json: any,
  fallback: Partial<KUploadFile>
): KUploadFile[] {
  if (!json) return [];
  const objs: any[] = [];
  deepCollectObjects(json, objs);

  // Heuristic: objects that look like attachment rows
  const rows = objs.filter((o) => {
    if (!o || typeof o !== 'object') return false;
    const keys = Object.keys(o);
    const hasName =
      'atchFileNm' in o ||
      'atchFileName' in o ||
      'fileNm' in o ||
      'orgnlAtchFileNm' in o ||
      'orgFileNm' in o ||
      'originalFileName' in o ||
      keys.some((k) => /file.*nm/i.test(k));
    const hasSeq =
      'atchFileSqno' in o ||
      'ATCH_FILE_SQNO' in o ||
      'atchFileSqNo' in o ||
      'fileSeq' in o ||
      'fileSn' in o ||
      keys.some((k) => /sqno|seq|sn/i.test(k));
    const hasUuid = 'untyAtchFileNo' in o || 'UNTY_ATCH_FILE_NO' in o;
    return (hasName && hasSeq) || (hasName && hasUuid);
  });

  const out: KUploadFile[] = [];
  for (const r of rows) {
    const name =
      String(
        r?.atchFileNm ??
          r?.atchFileName ??
          r?.fileNm ??
          r?.orgnlAtchFileNm ??
          r?.orgFileNm ??
          r?.originalFileName ??
          r?.ATCH_FILE_NM ??
          ''
      ).trim() ||
      '';
    const url = buildDownloadUrlFromKUploadRow(r, fallback);
    if (!name || !url) continue;
    out.push({
      name,
      url,
      untyAtchFileNo: String(r?.untyAtchFileNo ?? r?.UNTY_ATCH_FILE_NO ?? fallback.untyAtchFileNo ?? ''),
      atchFileSqno: r?.atchFileSqno ?? r?.ATCH_FILE_SQNO ?? fallback.atchFileSqno,
      bidPbancNo: r?.bidPbancNo ?? fallback.bidPbancNo,
      bidPbancOrd: r?.bidPbancOrd ?? fallback.bidPbancOrd,
      fileSeq: r?.fileSeq ?? r?.fileSn ?? fallback.fileSeq,
      bsnePath: String(fallback.bsnePath ?? ''),
      tblNm: String(fallback.tblNm ?? ''),
    });
  }

  // 휴리스틱에 안 걸린 객체(필드명 변형 등)라도 이름+URL 조합이 나오면 채택
  if (out.length === 0) {
    for (const o of objs) {
      if (!o || typeof o !== 'object') continue;
      const name =
        String(
          o?.atchFileNm ??
            o?.atchFileName ??
            o?.fileNm ??
            o?.orgnlAtchFileNm ??
            o?.orgFileNm ??
            o?.originalFileName ??
            o?.ATCH_FILE_NM ??
            ''
        ).trim() || '';
      if (!name) continue;
      const url = buildDownloadUrlFromKUploadRow(o, fallback);
      if (!url) continue;
      out.push({
        name,
        url,
        untyAtchFileNo: String(o?.untyAtchFileNo ?? o?.UNTY_ATCH_FILE_NO ?? fallback.untyAtchFileNo ?? ''),
        atchFileSqno: o?.atchFileSqno ?? o?.ATCH_FILE_SQNO ?? fallback.atchFileSqno,
        bidPbancNo: o?.bidPbancNo ?? fallback.bidPbancNo,
        bidPbancOrd: o?.bidPbancOrd ?? fallback.bidPbancOrd,
        fileSeq: o?.fileSeq ?? o?.fileSn ?? fallback.fileSeq,
        bsnePath: String(fallback.bsnePath ?? ''),
        tblNm: String(fallback.tblNm ?? ''),
      });
    }
  }

  // Deduplicate by name+url
  const seen = new Set<string>();
  return out.filter((f) => {
    const k = `${f.name}||${f.url}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * 나라장터 공고 상세 페이지에서 '제안요청정보'(e-발주 연계) 문서 목록을 최대한 보수적으로 파싱한다.
 * - HTML 구조가 자주 바뀌므로, 텍스트/URL 패턴 기반으로 추출한다.
 */
function parseProposalRequestDocsFromHtml(html: string): Attachment[] {
  const $ = cheerio.load(html);

  // 1) '제안요청' 키워드가 등장하는 블록 주변에서 링크를 수집
  const proposalLinks: Attachment[] = [];
  const keywordNodes = $('*:contains("제안요청")');

  keywordNodes.each((_, el) => {
    const $el = $(el);
    const scope =
      $el.closest('table, div, section, article').length > 0
        ? $el.closest('table, div, section, article')
        : $el.parent();

    scope
      .find('a')
      .each((__, a) => {
        const $a = $(a);
        const text = ($a.text() || $a.attr('title') || '').trim();
        const href = ($a.attr('href') || '').trim();
        const onclick = ($a.attr('onclick') || '').trim();

        const rawUrl = href && !href.toLowerCase().startsWith('javascript')
          ? href
          : '';

        // download 패턴이 onclick에 있는 케이스도 방어
        const onclickUrlMatch =
          !rawUrl && onclick
            ? onclick.match(/(https?:\/\/[^\s'"]+download[^\s'"]+|\/[^'"]*download[^'"]+)/i)
            : null;

        const url = absolutize(rawUrl || (onclickUrlMatch?.[1] ?? ''));
        if (!url) return;

        // 다운로드/첨부 문서로 보이는 링크만
        const looksLikeFile =
          /download/i.test(url) ||
          /UntyAtchFile/i.test(url) ||
          /atch/i.test(url) ||
          /\.(pdf|hwp|hwpx|docx?|xlsx?|pptx?|zip)$/i.test(url);
        if (!looksLikeFile) return;

        if (text) {
          proposalLinks.push({ name: text, url, source: 'proposal' });
        }
      });
  });

  // 2) e-발주 연계 다운로드 URL 패턴은 페이지 어디서든 잡되, '제안요청'이 주변 텍스트에 있는 경우 우선
  const globalCandidates: Attachment[] = [];
  $('a').each((_, a) => {
    const $a = $(a);
    const text = ($a.text() || $a.attr('title') || '').trim();
    const href = ($a.attr('href') || '').trim();
    if (!href || href.toLowerCase().startsWith('javascript')) return;
    const url = absolutize(href);
    if (!url) return;

    if (!/UntyAtchFile\/downloadFile\.do/i.test(url) && !/download/i.test(url)) return;

    // 주변(같은 row/부모) 텍스트에 제안요청/발주가 있을 때만 proposal로 채택
    const contextText = $a.closest('tr, li, div').text();
    const isProposalContext = /제안요청|e-발주|발주/i.test(contextText);
    if (!isProposalContext) return;

    if (text) globalCandidates.push({ name: text, url, source: 'proposal' });
  });

  return uniqAttachments([...proposalLinks, ...globalCandidates]);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const bidNo = (searchParams.get('bidNo') || '').trim();
  const bidOrd = (searchParams.get('bidOrd') || '').trim();
  const bfSpecRegNoFromQuery = (searchParams.get('bfSpecRegNo') || '').trim();
  const debug = (searchParams.get('debug') || '').trim() === '1';

  if (!bidNo) {
    return NextResponse.json({ error: 'bidNo가 필요합니다.' }, { status: 400 });
  }

  // 나라장터 상세 화면 URL 패턴(공고번호/차수)
  // 예: https://www.g2b.go.kr:8081/ep/invitation/publish/bidInfoDtl.do?bidno=...&bidseq=...
  const detailUrls = [
    new URL('https://www.g2b.go.kr:8081/ep/invitation/publish/bidInfoDtl.do'),
    // 일부 환경에서 8081이 막힐 수 있어 기본 도메인 경로도 시도
    new URL('https://www.g2b.go.kr/ep/invitation/publish/bidInfoDtl.do'),
  ];
  for (const u of detailUrls) {
    u.searchParams.set('bidno', bidNo);
    if (bidOrd) u.searchParams.set('bidseq', bidOrd);
    u.searchParams.set('releaseYn', 'Y');
    u.searchParams.set('taskClCd', '1');
  }

  try {
    let res: Response | null = null;
    let html = '';
    let usedDetailUrl = detailUrls[0].toString();

    for (const u of detailUrls) {
      usedDetailUrl = u.toString();
      try {
        const r = await fetch(usedDetailUrl, {
          cache: 'no-store',
          next: { revalidate: 0 },
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        });
        const t = await r.text();
        if (r.ok && t && t.length > 200) {
          res = r;
          html = t;
          break;
        }
      } catch {
        // ignore and try next URL
      }
    }

    if (!res) {
      // 상세 페이지가 네트워크/차단으로 실패해도, bfSpecRegNo가 있으면 Step1→Step2로 제안요청서를 복구할 수 있다.
      // (상세 HTML에 의존하지 않는 경로)
      if (!bfSpecRegNoFromQuery) {
        return NextResponse.json(
          { error: 'G2B 상세 페이지 조회 실패', status: 0, detail: 'fetch failed' },
          { status: 502 }
        );
      }
      usedDetailUrl = '';
    }

    // 1) 기존 방식(링크가 HTML에 있는 경우)도 유지
    const proposalFromLinks = html ? parseProposalRequestDocsFromHtml(html) : [];

    const referer = usedDetailUrl || `https://www.g2b.go.kr/link/PRVA004_02/?bfSpecRegNo=${encodeURIComponent(bfSpecRegNoFromQuery)}`;
    const cookie = res ? pickCookies(res.headers.get('set-cookie')) : '';

    // 2) KUpload(XHR) 기반 첨부:
    //    (A) bfSpecRegNo가 있으면 Step1/PRVA로 얻은 untyAtchFileNo를 항상 최우선 시도 (아래에서 specUuidCandidates로 병합).
    //        상세 HTML에 무관 UUID가 있으면 기존에는 Step1을 건너뛰어 제안요청 첨부만 비는 경우가 있었다.
    //    (B) 그다음 상세 HTML에서 추출한 UUID 후보(htmlUuidCandidates)를 덧붙인다.
    const htmlUuidCandidates = html ? extractUuidCandidatesFromHtml(html) : [];
    const uuidSources: Record<string, string> = {};
    htmlUuidCandidates.forEach((u) => (uuidSources[u] = 'detail_html'));
    let bfSpecRegNo = html ? extractBfSpecRegNoFromHtml(html) : null;
    const bfSpecRegNoFromHtml = bfSpecRegNo;

    // HTML에 bfSpecRegNo가 없으면 link 페이지에서 한 번 더 찾는다.
    if (!bfSpecRegNo) {
      const pbocHtml = await fetchPbocSinglePage(bidNo, bidOrd);
      if (pbocHtml) {
        bfSpecRegNo = extractBfSpecRegNoFromHtml(pbocHtml);
      }
    }

    if (!bfSpecRegNo && bfSpecRegNoFromQuery) {
      bfSpecRegNo = bfSpecRegNoFromQuery;
    }
    let bsneClsfCd = (html ? extractBsneClsfCdFromHtml(html) : null) ?? null;
    let apiCtx = { cookie, referer };
    const prvaRefererForSpec = bfSpecRegNo
      ? `https://www.g2b.go.kr/link/PRVA004_02/?bfSpecRegNo=${encodeURIComponent(bfSpecRegNo)}`
      : '';

    // Step1: bfSpecRegNo → selectBfSpec.do → untyAtchFileNo 확보
    let step1HttpStatus: number | null = null;
    let step1ParseOk: boolean | null = null;
    let step1FoundUuid: string | null = null;
    let step1Error: any = null;
    let step1BodySnippet: string | null = null;
    let step1JsonKeys: string[] | null = null;
    let prvaHtmlLen: number | null = null;
    let prvaAnyUuidCount: number | null = null;
    let prvaFoundUntyUuid: string | null = null;
    let bfSpecModuleWarmup: { ok: boolean; url: string | null } | null = null;
    const specUuidCandidates: string[] = [];

    if (bfSpecRegNo) {
      // 추가: 루트 페이지로 세션 쿠키 확보
      const rootCookie = await warmupRoot();
      if (rootCookie) {
        apiCtx = { ...apiCtx, cookie: mergeCookieStrings(apiCtx.cookie, rootCookie) };
      }

      const warmed = await warmupPrvaPageForBfSpec(bfSpecRegNo);
      if (warmed) {
        apiCtx = {
          cookie: mergeCookieStrings(apiCtx.cookie, warmed.cookie),
          // referer는 실제 상세 페이지를 유지 (XHR 차단(403) 방지에 중요)
          referer: apiCtx.referer,
        };
      }

      // 추가: BfSpec 모듈 페이지를 밟아 권한/세션 컨텍스트를 확보해본다.
      const modWarm = await warmupBfSpecModulePage(bfSpecRegNo, apiCtx.cookie);
      apiCtx = { ...apiCtx, cookie: modWarm.cookie };
      bfSpecModuleWarmup = { ok: modWarm.ok, url: modWarm.url };

      try {
        // Step1은 Referer에 민감할 수 있어, (A) 상세 referer, (B) PRVA referer 2개를 순차 시도한다.
        const tryReferers = [
          apiCtx.referer,
          `https://www.g2b.go.kr/link/PRVA004_02/?bfSpecRegNo=${encodeURIComponent(bfSpecRegNo)}`,
          ...(modWarm.url ? [modWarm.url] : []),
        ];
        for (const ref of tryReferers) {
          const r = await fetchBfSpecDetailRaw({ ...apiCtx, referer: ref }, bfSpecRegNo);
          step1HttpStatus = r.status;
          step1ParseOk = r.json != null;
          step1BodySnippet = r.text ? String(r.text).slice(0, 600) : null;
          step1JsonKeys =
            r.json && typeof r.json === 'object' ? Object.keys(r.json).slice(0, 50) : null;
          if (r.json) {
            step1Error =
              r.json?.error ??
              r.json?.result ??
              r.json?.message ??
              r.json?.resultMsg ??
              r.json?.msg ??
              r.json?.ErrorMsg ??
              r.json?.ErrorCode ??
              r.json?.header?.resultMsg ??
              r.json?.header?.message ??
              r.json?.response?.header?.resultMsg ??
              r.json?.body?.resultMsg ??
              null;

            const dlBfSpecM =
              r.json?.dlBfSpecM ??
              r.json?.data?.dlBfSpecM ??
              r.json?.result?.dlBfSpecM ??
              r.json?.response?.dlBfSpecM ??
              null;
            const step1Uuid = String(dlBfSpecM?.untyAtchFileNo ?? '').trim();
            if (step1Uuid) {
              step1FoundUuid = step1Uuid;
              specUuidCandidates.push(step1Uuid);
              uuidSources[step1Uuid] = 'step1';
              break;
            }
          }
          // If forbidden, try next referer variant.
        }
      } catch {
        // ignore
      }

      // Step1이 403으로 막히는 경우(권한 -801)에도, PRVA 링크 페이지 HTML에 UUID가 노출되는 케이스가 있어 추가 추출 시도
      if (specUuidCandidates.length === 0) {
        const prvaHtml = await fetchPrvaPageHtml(bfSpecRegNo);
        if (prvaHtml) {
          prvaHtmlLen = prvaHtml.length;
          const all = extractUuidCandidatesFromHtml(prvaHtml);
          prvaAnyUuidCount = all.length;
          // PRVA HTML에서 untyAtchFileNo에 바인딩된 UUID는 여러 개일 수 있어 전부 시도한다.
          const untyUuids = extractAllUntyAtchFileNosFromHtml(prvaHtml);
          prvaFoundUntyUuid = untyUuids[0] ?? null;
          for (const u of untyUuids) {
            specUuidCandidates.push(u);
            uuidSources[u] = 'prva_html';
          }

          // detail HTML에서 못 얻었으면 PRVA HTML에서도 업종코드(bsneClsfCd)를 시도
          if (!bsneClsfCd) {
            bsneClsfCd = extractBsneClsfCdFromHtml(prvaHtml);
          }

          // PRVA에서 나온 UUID면 Step2 Referer도 PRVA로 맞춘다.
          if (untyUuids.length > 0 && prvaRefererForSpec) {
            apiCtx = { ...apiCtx, referer: prvaRefererForSpec };
          }

          // 마지막 fallback: untyAtchFileNo 키가 안 잡히면, 그래도 UUID 1개만 있는 케이스는 후보로 추가
          if (untyUuids.length === 0) {
            const fallbackUuid = pickBestUuidFromHtml(prvaHtml);
            if (fallbackUuid) {
              specUuidCandidates.push(fallbackUuid);
              uuidSources[fallbackUuid] = 'prva_html_fallback';
            }
          }
        }
      }
    }

    const uuidCandidates: string[] = [];
    const mergedUuidSeen = new Set<string>();
    for (const u of specUuidCandidates) {
      const k = u.toLowerCase();
      if (mergedUuidSeen.has(k)) continue;
      mergedUuidSeen.add(k);
      uuidCandidates.push(u);
    }
    for (const u of htmlUuidCandidates) {
      const k = u.toLowerCase();
      if (mergedUuidSeen.has(k)) continue;
      mergedUuidSeen.add(k);
      uuidCandidates.push(u);
    }

    if (!bsneClsfCd) bsneClsfCd = '업130020';

    const bidPbancOrdPadded = padBidPbancOrd(bidOrd);
    const bidPbancFallback: Partial<KUploadFile> = {
      bidPbancNo: bidNo,
      bidPbancOrd: bidPbancOrdPadded,
    };

    const kuploadFiles: Attachment[] = [];
    let step2LastStatus: number | null = null;
    let step2LastParseOk: boolean | null = null;
    let step2LastBodySnippet: string | null = null;
    let step2LastJsonKeys: string[] | null = null;
    let step2LastNormalizedCount: number | null = null;
    for (const [i, untyAtchFileNo] of uuidCandidates.entries()) {
      // 과도 호출 방지
      if (i > 0) await new Promise((r) => setTimeout(r, 120));

      // Payload 후보 2종(PRVA / PNPE) 모두 시도해 누락을 최소화
      const payloads: Array<{ body: any; fallback: Partial<KUploadFile> }> = [
        {
          body: {
            dlUntyAtchFileM: { untyAtchFileNo, bsnePath: 'PRVA' },
            bsneClsfCd,
            bsnePath: 'PRVA',
            colNm: 'UNTY_ATCH_FILE_NO',
            tblNm: 'PBANC_BF_SPEC',
            untyAtchFileNo,
          },
          fallback: { untyAtchFileNo, bsnePath: 'PRVA', tblNm: 'PBANC_BF_SPEC', ...bidPbancFallback },
        },
        {
          body: {
            dlUntyAtchFileM: { untyAtchFileNo, bsnePath: 'PNPE' },
            bsneClsfCd,
            bsnePath: 'PNPE',
            colNm: 'ITEM_PBANC_UNTY_ATCH_FILE_NO',
            tblNm: 'PBANC_BID_PBANC',
            untyAtchFileNo,
          },
          fallback: { untyAtchFileNo, bsnePath: 'PNPE', tblNm: 'PBANC_BID_PBANC', ...bidPbancFallback },
        },
      ];

      for (const p of payloads) {
        const r = debug
          ? await fetchKUploadFileListWithDebug(apiCtx, p.body)
          : { status: 200, text: '', json: await fetchKUploadFileList(apiCtx, p.body) };
        step2LastStatus = r.status;
        step2LastParseOk = r.json != null;
        step2LastBodySnippet = r.text ? String(r.text).slice(0, 600) : null;
        step2LastJsonKeys =
          r.json && typeof r.json === 'object' ? Object.keys(r.json).slice(0, 50) : null;

        const normalized = normalizeKUploadFilesFromResponse(r.json, p.fallback);
        step2LastNormalizedCount = normalized.length;
        for (const f of normalized) {
          kuploadFiles.push({ name: f.name, url: f.url, source: 'proposal' });
        }
      }

      // 하나라도 찾았으면 더 이상의 UUID 시도는 중단(불필요 호출 방지)
      if (kuploadFiles.length > 0) break;
    }

    // If we still couldn't fetch any files, try headless browser fallback (last resort).
    let playwrightTried = false;
    let playwrightGot = 0;
    let playwrightError: string | null = null;
    if (kuploadFiles.length === 0) {
      playwrightTried = true;
      try {
        const pwFiles = await fetchProposalFilesViaPlaywright({
          bidNo,
          bidOrd,
          bfSpecRegNo,
          bsneClsfCdFallback: bsneClsfCd,
        });
        playwrightGot = pwFiles.length;
        kuploadFiles.push(...pwFiles);
      } catch (e: any) {
        playwrightError = String(e?.message ?? e ?? '');
      }
    }

    const proposalFiles = uniqAttachments([...proposalFromLinks, ...kuploadFiles]);
    return NextResponse.json(
      debug
        ? {
            bidNo,
            bidOrd,
            proposalFiles,
            debug: {
              usedDetailUrl,
              bfSpecRegNoFromQuery: bfSpecRegNoFromQuery || null,
              bfSpecRegNoFromHtml: bfSpecRegNoFromHtml || null,
              bfSpecRegNoFinal: bfSpecRegNo || null,
              uuidCandidatesCount: uuidCandidates.length,
              uuidCandidates: uuidCandidates.slice(0, 5).map((u) => ({ u, source: uuidSources[u] ?? '?' })),
              step1: {
                httpStatus: step1HttpStatus,
                parseOk: step1ParseOk,
                foundUuid: step1FoundUuid,
                error: step1Error,
                bodySnippet: step1BodySnippet,
                jsonKeys: step1JsonKeys,
                refererUsed: apiCtx.referer,
                hasCookie: Boolean(apiCtx.cookie),
              },
              prva: {
                htmlLen: prvaHtmlLen,
                anyUuidCount: prvaAnyUuidCount,
                foundUntyAtchFileNo: prvaFoundUntyUuid,
              },
              bfSpecModuleWarmup,
              step2: {
                lastStatus: step2LastStatus,
                lastParseOk: step2LastParseOk,
                lastJsonKeys: step2LastJsonKeys,
                lastBodySnippet: step2LastBodySnippet,
                lastNormalizedCount: step2LastNormalizedCount,
              },
              playwright: debug
                ? { tried: playwrightTried, got: playwrightGot, error: playwrightError }
                : undefined,
              proposalFromLinksCount: proposalFromLinks.length,
              kuploadCount: kuploadFiles.length,
            },
            fetchedAt: new Date().toISOString(),
          }
        : {
            bidNo,
            bidOrd,
            proposalFiles,
            fetchedAt: new Date().toISOString(),
          }
    );
  } catch (e: any) {
    return NextResponse.json(
      { error: 'G2B 상세 페이지 통신 실패', detail: String(e?.message ?? e ?? '') },
      { status: 502 }
    );
  }
}


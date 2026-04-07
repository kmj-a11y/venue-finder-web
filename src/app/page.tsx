// @ts-nocheck
"use client";
import React, { useState, useEffect, useRef } from 'react';
import { 
  Search, RefreshCcw, MapPin, Users, Calendar, Mail, Phone, User, 
  ExternalLink, ChevronRight, ChevronDown, Download, AlertCircle, Building2, Clock, 
  FileText, Trophy, Activity, Settings, Plus, X, Save, BarChart3,
  Key, Archive, Bookmark, BookmarkCheck, CheckCircle2, List, Loader2
} from 'lucide-react';

/** 공고명에 공백/붙여쓰기 관계없이 '채용대행' 또는 '채용위탁' 용역만 표시 */
function isRecruitmentAgencyBidTitle(title: string | undefined | null): boolean {
  if (!title || typeof title !== 'string') return false;
  const compact = title.replace(/\s+/g, '');
  return compact.includes('채용대행') || compact.includes('채용위탁');
}

function hasRealSummary(bid: any) {
  const s = bid.summary;
  if (!s || s === '-' || String(s).trim() === '') return false;
  const text = String(s);
  if (text.includes('파일 읽기 에러') || text.includes('파일 읽기 실패')) return false;
  if (text.includes('첨부파일 본문을 읽을 수 없으므로')) return false;
  return true;
}

/** `<input type="month" />` 초기값 — 한국 시간 기준 오늘이 속한 달(공고 일자와 맞춤) */
function yyyyMmKstToday() {
  const s = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });
  return s.split(' ')[0].slice(0, 7);
}

/** 게시일 문자열 기준 최신순 정렬 */
function compareBidsByNoticeDesc(a: any, b: any) {
  const da = String(a.noticeDate ?? '').replace(/\D/g, '');
  const db = String(b.noticeDate ?? '').replace(/\D/g, '');
  return db.localeCompare(da, undefined, { numeric: true });
}

/**
 * API로 받은 건은 최신 필드로 갱신하고, 이미 분석해 둔 summary 등은 유지.
 * API에 일시적으로 안 나오는 id도 기존 목록에서 사라지지 않음(증분 동기화).
 */
function mergeFetchedBidsWithPrevious(prev: any, freshWithCache: any) {
  const map = new Map<string, any>(
    (prev ?? []).map((b: any) => [String(b.id ?? ''), b] as const)
  );
  for (const b of freshWithCache as any[]) {
    const old: any = map.get(String(b?.id ?? ''));
    if (!old) {
      map.set(String(b?.id ?? ''), b);
      continue;
    }
    const keepSummary =
      old.summary &&
      old.summary !== '-' &&
      !String(old.summary).startsWith('⚠️') &&
      hasRealSummary(old);
    map.set(String(b?.id ?? ''), {
      ...b,
      summary: keepSummary ? old.summary : b.summary,
      result_status: b.result_status ?? old.result_status,
      result_winner: b.result_winner ?? old.result_winner,
    });
  }
  return Array.from(map.values()).sort(compareBidsByNoticeDesc);
}

function formatKoreanCurrency(amount: any) {
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

function safeFormatDate(str: any) {
  if (str == null || str === '') return '-';
  const digits = String(str).replace(/\D/g, '');
  if (digits.length < 8) return '-';
  const y = digits.slice(0, 4);
  const m = digits.slice(4, 6);
  const d = digits.slice(6, 8);
  return `${y}-${m}-${d}`;
}

function renderSummaryHtml(text: any) {
  if (text == null || text === '') return '-';
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br/>');
}

/** 공고 게시일(noticeDate YYYY-MM-DD)이 헤더에서 선택한 월(YYYY-MM)과 일치하는지 */
function bidNoticeInSelectedMonth(bid: any, monthYm: string) {
  const nd = bid?.noticeDate;
  if (nd == null || nd === '' || nd === '-') return false;
  const s = String(nd).trim();
  return s.length >= 7 && s.slice(0, 7) === monthYm;
}

/** 개찰 보충 API 대상: 입찰 마감 또는 종료 */
function isClosedOrEndedBidStatus(status: any) {
  const t = String(status ?? '').trim();
  if (t === '입찰 마감') return true;
  if (t === '종료') return true;
  return false;
}

const RESULT_FETCH_THROTTLE_MS = 500;

/** 영업 메모: 다중 줄 + scrollHeight 기반 자동 높이 (렌더 루프/의존성과 분리된 로컬 ref) */
function PipelineSalesMemoTextarea({
  bidId,
  memo,
  onSave,
  className,
}: {
  bidId: string;
  memo: string;
  onSave: (value: string) => void;
  className?: string;
}) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const adjustHeight = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight, 42)}px`;
  };
  useEffect(() => {
    adjustHeight();
  }, [bidId, memo]);
  return (
    <textarea
      ref={taRef}
      placeholder="고객 반응, 다음 액션 등을 적어 두세요"
      defaultValue={memo ?? ''}
      key={`memo-${bidId}-${String(memo ?? '')}`}
      onChange={(e) => {
        const el = e.target;
        el.style.height = 'auto';
        el.style.height = `${Math.max(el.scrollHeight, 42)}px`;
      }}
      onBlur={(e) => onSave(e.target.value)}
      rows={1}
      className={className}
    />
  );
}

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

export default function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'pipeline' | 'settings'>('dashboard');
  const [isLoading, setIsLoading] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [loadingPhase, setLoadingPhase] = useState<'idle' | 'fetch'>('idle');
  const [toastMessage, setToastMessage] = useState('');

  const [selectedMonth, setSelectedMonth] = useState(() => yyyyMmKstToday());
  const [searchKeyword, setSearchKeyword] = useState('');
  const [showSavedOnly, setShowSavedOnly] = useState(false);
  const [bids, setBids] = useState<any[]>([]);
  const bidsRef = useRef<any[]>([]);
  const savedBidIdsRef = useRef<Set<string>>(new Set());
  const [selectedBid, setSelectedBid] = useState<any | null>(null);
  const [bidResult, setBidResult] = useState<any | null>(null);
  const [savedBidIds, setSavedBidIds] = useState(new Set()); 
  const [savedBidsData, setSavedBidsData] = useState<any[]>([]);
  const [analyzedBidIds, setAnalyzedBidIds] = useState<Set<string>>(new Set());
  const [ccQuota, setCcQuota] = useState<number | null>(null);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [summaryModalOpen, setSummaryModalOpen] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [prompts, setPrompts] = useState([
    {
      id: '1',
      title: '입찰 메타데이터 분석',
      content: `너는 공공기관 입찰 분석 전문가야. 제공된 공고명, 수요기관, 배정예산, 첨부파일 목록을 바탕으로 분석 리포트를 작성해. 요약은 필요한 만큼 충분히 작성해 줘. 줄 수나 글자 수 제한을 두지 마.

[주의사항]
- 첨부파일 본문을 직접 읽을 수 없으면, 구체적인 채용 인원·대관 장소는 유추하지 말고 "확인 불가"로 명시해.
- 파일 목록 중 **어떤 파일(과업지시서, 제안요청서 등)**을 열어봐야 '서울 대관 여부'를 확인할 수 있는지 구체적으로 안내해 줘.

[분석 항목]
1. 🎯 공고 성격 (단순 유추)
2. 💰 사업 규모 (예산 기반 유추)
3. 🔍 팩트 체크 필요: 서울 면접/필기장 대관 여부, 상세 채용 인원 (확인 불가면 명시)
4. 📎 핵심 확인 문서: 담당자가 반드시 열어봐야 할 첨부파일명을 정확히 지목`,
    },
  ]);
  const [activePromptId, setActivePromptId] = useState('1');
  const [editingPromptContent, setEditingPromptContent] = useState('');
  const [footerTime, setFooterTime] = useState(''); // 하이드레이션 방지: 마운트 후에만 시각 표시
  const [pipelineSummaryModalBidId, setPipelineSummaryModalBidId] = useState<string | null>(null);
  const proposalFilesCacheRef = useRef<Map<string, Array<{ name: string; url: string }>>>(
    new Map()
  );
  /** 상세 첨부 API를 이미 실패한 공고 — 자동 재시도 금지(무한 폴링·과호출 방지) */
  const proposalFilesFailedRef = useRef<Set<string>>(new Set());
  const proposalFilesInFlightRef = useRef<string | null>(null);
  const [expandedBidId, setExpandedBidId] = useState<string | null>(null);
  const [proposalDetailLoadingBidId, setProposalDetailLoadingBidId] = useState<string | null>(null);
  const [, setProposalDetailUiTick] = useState(0);
  const [editingManualPhoneId, setEditingManualPhoneId] = useState<string | null>(null);
  const [editingManualEmailId, setEditingManualEmailId] = useState<string | null>(null);
  const [selectedPipelineBidId, setSelectedPipelineBidId] = useState<string | null>(null);
  const [editingSummaryBidId, setEditingSummaryBidId] = useState<string | null>(null);
  const [editingSummaryDraft, setEditingSummaryDraft] = useState<string>('');
  const summaryTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const loadInitialData = async () => {
      try {
        const { data: appSettings, error: appError } = await supabase
          .from('app_settings')
          .select('*')
          .eq('id', 1)
          .single();

        if (!appError && appSettings) {
          if (appSettings.gemini_api_key) {
            setGeminiApiKey(appSettings.gemini_api_key);
          }
        }

        const { data: promptsData, error: promptsError } = await supabase
          .from('prompts')
          .select('id, title, content')
          .order('created_at', { ascending: true });

        if (!promptsError && promptsData && promptsData.length > 0) {
          setPrompts(promptsData);
          setActivePromptId(promptsData[0].id);
        }
      } catch (error) {
        console.error('초기 설정 불러오기 중 오류:', error);
      }
    };

    loadInitialData();
    handleRefresh(true);
  }, []);

  useEffect(() => {
    fetchQuota();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ data: savedRows, error: savedErr }, { data: analyzedRows, error: analyzedErr }] =
        await Promise.all([
          supabase.from('saved_bids').select('*').order('notice_date', { ascending: false }),
          supabase.from('analyzed_bids').select('bid_id'),
        ]);
      if (cancelled) return;
      if (savedErr) {
        console.error('saved_bids load error:', savedErr);
        return;
      }
      if (analyzedErr) {
        console.error('analyzed_bids load error:', analyzedErr);
      }
      const rows = savedRows ?? [];
      setSavedBidsData(rows);
      setSavedBidIds(new Set(rows.map((r: { bid_id: string }) => r.bid_id)));
      setAnalyzedBidIds(
        new Set((analyzedRows ?? []).map((r: { bid_id: string }) => String(r.bid_id)))
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    bidsRef.current = bids;
  }, [bids]);

  useEffect(() => {
    savedBidIdsRef.current = savedBidIds;
  }, [savedBidIds]);

  const adjustSummaryTextareaHeight = () => {
    const el = summaryTextareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight, 120)}px`;
  };

  const startEditingSummary = (bidId: string, currentSummary: any) => {
    setEditingSummaryBidId(bidId);
    setEditingSummaryDraft(String(currentSummary ?? ''));
    // 다음 tick에서 높이 계산
    setTimeout(() => adjustSummaryTextareaHeight(), 0);
  };

  const cancelEditingSummary = () => {
    setEditingSummaryBidId(null);
    setEditingSummaryDraft('');
  };

  const saveEditedSummary = async (bidId: string) => {
    const nextSummary = String(editingSummaryDraft ?? '');
    try {
      // 1) cache DB 업데이트 (요구사항: UPDATE)
      const { data: updatedRows, error: cacheUpErr } = await supabase
        .from('ai_analysis_cache')
        .update({ summary: nextSummary })
        .eq('bid_id', bidId)
        .select('bid_id');
      if (cacheUpErr) throw cacheUpErr;

      // 캐시가 아직 없던 케이스면 INSERT로 보완
      if (!updatedRows || updatedRows.length === 0) {
        const { error: cacheInsErr } = await supabase
          .from('ai_analysis_cache')
          .insert({ bid_id: bidId, summary: nextSummary });
        if (cacheInsErr) throw cacheInsErr;
      }

      // 2) 파이프라인(saved_bids)에도 요약을 유지(탭 간 실시간 동기화)
      if (savedBidIdsRef.current.has(bidId)) {
        const { error: savedErr } = await supabase
          .from('saved_bids')
          .update({ summary: nextSummary })
          .eq('bid_id', bidId);
        if (savedErr) {
          // cache는 성공했으므로 UI는 갱신하되, 파이프라인 DB 반영 실패는 로그만 남김
          console.error('saved_bids summary update:', savedErr);
        }
      }

      // 3) 전역 상태 즉시 반영 (대시보드/파이프라인 동기화)
      setBids((prev) => {
        const next = (prev ?? []).map((b) => (b.id === bidId ? { ...b, summary: nextSummary } : b));
        bidsRef.current = next;
        return next;
      });
      setSelectedBid((prev) => (prev && prev.id === bidId ? { ...prev, summary: nextSummary } : prev));
      setSavedBidsData((prev) => (prev ?? []).map((r) => (r.bid_id === bidId ? { ...r, summary: nextSummary } : r)));

      showToast('AI 요약이 저장되었습니다.');
      cancelEditingSummary();
    } catch (e) {
      console.error('saveEditedSummary:', e);
      showToast('요약 저장에 실패했습니다.');
    }
  };

  const toggleAnalyzedStatus = async (bidId: string) => {
    const isAnalyzed = analyzedBidIds.has(bidId);
    try {
      if (isAnalyzed) {
        const { error } = await supabase.from('analyzed_bids').delete().eq('bid_id', bidId);
        if (error) throw error;
        setAnalyzedBidIds((prev) => {
          const next = new Set(prev);
          next.delete(bidId);
          return next;
        });
      } else {
        const { error } = await supabase.from('analyzed_bids').upsert({ bid_id: bidId }, { onConflict: 'bid_id' });
        if (error) throw error;
        setAnalyzedBidIds((prev) => new Set(prev).add(bidId));
      }
    } catch (err) {
      console.error('toggleAnalyzedStatus:', err);
      showToast(err instanceof Error ? err.message : '분석 완료 상태 저장에 실패했습니다.');
    }
  };

  useEffect(() => {
    setEditingPromptContent(prompts.find(p => p.id === activePromptId)?.content || '');
  }, [activePromptId, prompts]);

  useEffect(() => {
    setFooterTime(new Date().toLocaleTimeString());
  }, []);

  useEffect(() => {
    setUploadFiles([]);
  }, [selectedBid?.id]);

  useEffect(() => {
    if (!selectedBid) {
      setBidResult(null);
      return;
    }
    if (selectedBid.status !== '입찰 마감' || !selectedBid.bidNtceNo) {
      setBidResult(null);
      return;
    }
    let cancelled = false;
    setBidResult(null);
    fetch(`/api/result?bidNo=${encodeURIComponent(selectedBid.bidNtceNo)}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || data.status == null) return;
        const statusStr = data.status !== '-' && data.status != null ? String(data.status) : null;
        const winnerStr =
          data.winner != null && String(data.winner).trim() !== '' && data.winner !== '-'
            ? String(data.winner).trim()
            : null;
        setBidResult({ status: data.status, winner: data.winner ?? '-', amount: data.amount ?? '-' });
        setBids((prev: any[]) =>
          prev.map((b) =>
            b.id === selectedBid.id
              ? { ...b, result_status: statusStr ?? b.result_status, result_winner: winnerStr ?? b.result_winner }
              : b
          )
        );
        setSelectedBid((prev: any) =>
          prev && prev.id === selectedBid.id
            ? {
                ...prev,
                result_status: statusStr ?? prev.result_status,
                result_winner: winnerStr ?? prev.result_winner,
              }
            : prev
        );
      })
      .catch(() => {
        if (!cancelled) setBidResult(null);
      });
    return () => { cancelled = true; };
  }, [selectedBid?.id, selectedBid?.status, selectedBid?.bidNtceNo]);

  const showToast = (msg) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(''), 3000);
  };

  const fetchQuota = async () => {
    try {
      const res = await fetch('/api/quota', { cache: 'no-store' });
      if (!res.ok) {
        console.error('fetchQuota: 응답 비정상 status=', res.status);
        setCcQuota(null);
        return;
      }
      let data: { credits?: number | null; error?: string };
      try {
        data = await res.json();
      } catch (parseErr) {
        console.error('fetchQuota: JSON 파싱 실패', parseErr);
        setCcQuota(null);
        return;
      }
      if (typeof data?.credits === 'number') {
        setCcQuota(data.credits);
      } else {
        setCcQuota(null);
      }
    } catch (err) {
      console.error('fetchQuota: 네트워크/예외', err);
      setCcQuota(null);
    }
  };

  /**
   * API 최신화 버튼(handleRefresh)에서만 호출 — useEffect에 넣지 말 것(무한 호출 방지).
   * 선택 월 + 입찰마감/종료 + 개찰 미확정만 순차 호출(0.5초 간격).
   */
  const refreshResultsForSelectedMonth = async (currentBids: any[], monthYm: string) => {
    try {
      const targets = (currentBids ?? []).filter((b) => {
        if (!b) return false;
        if (!bidNoticeInSelectedMonth(b, monthYm)) return false;
        if (!isClosedOrEndedBidStatus(b.status)) return false;
        if (!b.bidNtceNo) return false;

        const rs = b.result_status;
        const rw = b.result_winner;
        const hasWinner = rw != null && String(rw).trim() !== '' && String(rw).trim() !== '-';
        const hasYuchal = rs != null && /유찰/.test(String(rs).trim());
        const hasAnyResult = (rs != null && String(rs).trim() !== '') || hasWinner;
        if (hasWinner || hasYuchal) return false;
        if (hasAnyResult) return false;

        return true;
      });

      for (const bid of targets) {
        try {
          const r = await fetch(`/api/result?bidNo=${encodeURIComponent(bid.bidNtceNo)}`, { cache: 'no-store' });
          const data = await r.json().catch(() => null);
          if (data?.status == null) {
            // no-op
          } else {
            const statusStr = data.status !== '-' && data.status != null ? String(data.status) : null;
            const winnerStr =
              data.winner != null && String(data.winner).trim() !== '' && data.winner !== '-'
                ? String(data.winner).trim()
                : null;

            if (statusStr || winnerStr) {
              setBids((prev) => {
                const next = (prev ?? []).map((b) =>
                  b.id === bid.id
                    ? {
                        ...b,
                        result_status: statusStr ?? b.result_status,
                        result_winner: winnerStr ?? b.result_winner,
                      }
                    : b
                );
                bidsRef.current = next;
                return next;
              });
              setSelectedBid((prev) =>
                prev && prev.id === bid.id
                  ? {
                      ...prev,
                      result_status: statusStr ?? prev.result_status,
                      result_winner: winnerStr ?? prev.result_winner,
                    }
                  : prev
              );

              if (savedBidIdsRef.current.has(bid.id)) {
                const { error: upErr } = await supabase
                  .from('saved_bids')
                  .update({
                    result_status: statusStr,
                    result_winner: winnerStr,
                    status: bid.status,
                  })
                  .eq('bid_id', bid.id);
                if (upErr) {
                  console.error('saved_bids partial result update error:', upErr);
                } else {
                  setSavedBidsData((prev) =>
                    prev.map((r) =>
                      r.bid_id === bid.id
                        ? {
                            ...r,
                            result_status: statusStr ?? r.result_status,
                            result_winner: winnerStr ?? r.result_winner,
                            status: bid.status ?? r.status,
                          }
                        : r
                    )
                  );
                }
              }
            }
          }
        } catch (e) {
          console.error('refreshResultsForSelectedMonth item error:', e);
        }

        await new Promise((resolve) => setTimeout(resolve, RESULT_FETCH_THROTTLE_MS));
      }
    } catch (e) {
      console.error('refreshResultsForSelectedMonth error:', e);
    }
  };

  const handleRefresh = async (skipResultBackfill = false) => {
    let mergedSnapshot: any[] | null = null;
    setIsLoading(true);
    setLoadingPhase('fetch');
    try {
      // 조달청 API는 공고명(bidNtceNm) 부분검색 — 기본 '채용'으로 넓게 받은 뒤, 아래 필터에서 채용대행·채용위탁만 표시
      const keyword = searchKeyword.trim() || '채용대행';
      const res = await fetch(`/api/sync-current?month=${selectedMonth}&keyword=${encodeURIComponent(keyword)}`, {
        cache: 'no-store',
      });
      const data = await res.json();

      if (!res.ok) {
        const apiErr = typeof data?.error === 'string' ? data.error : '';
        const apiMsg = typeof data?.resultMsg === 'string' ? data.resultMsg : '';
        showToast(
          apiErr || apiMsg
            ? `공고 조회 실패: ${apiMsg || apiErr}`
            : '공고 데이터를 가져오는 데 실패했습니다.'
        );
        return;
      }

      const items = data?.response?.body?.items ?? data?.body?.items ?? null;
      const rawItems = items?.item != null ? items.item : items;
      let itemList = rawItems == null ? [] : Array.isArray(rawItems) ? rawItems : [rawItems];
      if (!Array.isArray(itemList)) {
        itemList = [];
      }

      if (itemList.length === 0) {
        showToast('조회된 신규 공고가 없습니다. 기존 목록은 유지됩니다.');
        return;
      }

      const now = new Date();
      const mapItem = (item) => {
        const bidNtceNo = item.bidNtceNo ?? '';
        const bidNtceOrd = item.bidNtceOrd ?? '';
        const bfSpecRegNo =
          item.bfSpecRegNo ??
          item.bf_spec_reg_no ??
          item.bfSpecRegNoVal ??
          item.bfSpecRegNoNm ??
          null;
        const bidClseDt = item.bidClseDt ?? '';
        const bidNtceDt = item.bidNtceDt ?? item.regDt ?? bidClseDt;
        const asignBdgtAmt = item.asignBdgtAmt;
        const presmptPrce = item.presmptPrce;
        const budget = formatKoreanCurrency(asignBdgtAmt);
        const estimatedPrice = formatKoreanCurrency(presmptPrce);
        const files = [];
        for (let i = 1; i <= 10; i++) {
          const name = item[`ntceSpecFileNm${i}`];
          const url = item[`ntceSpecDocUrl${i}`];
          if (name && url) files.push({ name: String(name).trim(), url: String(url).trim() });
        }
        const deadlineStr = safeFormatDate(bidClseDt);
        const noticeDateStr = safeFormatDate(bidNtceDt);
        const digits = String(bidClseDt ?? '').replace(/\D/g, '');
        let closeTime = null;
        if (digits.length >= 8) {
          const y = digits.slice(0, 4), m = digits.slice(4, 6), d = digits.slice(6, 8);
          const h = digits.length >= 12 ? digits.slice(8, 10) : '23';
          const min = digits.length >= 12 ? digits.slice(10, 12) : '59';
          closeTime = new Date(`${y}-${m}-${d}T${h}:${min}:00`);
        }
        const status = closeTime ? (closeTime >= now ? '입찰서 접수중' : '입찰 마감') : '-';

        const rawRs = item.result_status ?? item.opengRsltNm ?? item.bidRsltNm ?? item.progrsDivCdNm;
        const rawRw = item.result_winner ?? item.fnlsucsfNm ?? item.bidwinnrNm ?? item.opengCorpNm;
        const result_status =
          rawRs != null && String(rawRs).trim() !== '' ? String(rawRs).trim() : null;
        const result_winner =
          rawRw != null && String(rawRw).trim() !== '' && String(rawRw).trim() !== '-'
            ? String(rawRw).trim()
            : null;

        return {
          id: `${bidNtceNo}-${bidNtceOrd}`,
          bidNtceNo,
          bidNtceOrd,
          bfSpecRegNo:
            // 일부 공고는 e-발주(제안요청정보) 연계 때문에 bfSpecRegNo가 목록 API에 안 내려오는 케이스가 있음
            // (현재 확인된 케이스는 하드코딩 매핑으로 우선 복구)
            bidNtceNo === 'R26BK01406727'
              ? 'R26BD00196101'
              : bfSpecRegNo,
          title: item.bidNtceNm ?? '-',
          org: item.ntceInsttNm ?? '-',
          dept: '-',
          manager: '-',
          phone: '-',
          email: '-',
          deadline: deadlineStr,
          noticeDate: noticeDateStr,
          budget,
          estimatedPrice,
          scale: '-',
          venue: '-',
          status,
          summary: '-',
          result_status,
          result_winner,
          result: { winner: '-', price: '-' },
          files,
          crawledAt: new Date().toISOString(),
        };
      };

      const rawBids = itemList.map(mapItem);
      const filteredBids = rawBids;

      if (filteredBids.length === 0) {
        showToast(
          '이번 조회에서 채용대행·채용위탁 조건에 맞는 공고가 없습니다. 기존 목록은 유지됩니다.'
        );
        return;
      }

      const bidIds = filteredBids.map((b) => b.id).filter(Boolean);
      const cacheMap = new Map();
      if (bidIds.length > 0) {
        const { data: cacheRows } = await supabase
          .from('ai_analysis_cache')
          .select('bid_id, summary')
          .in('bid_id', bidIds);
        (cacheRows ?? []).forEach((r) => {
          if (r.bid_id != null && r.summary != null) cacheMap.set(r.bid_id, String(r.summary));
        });
      }
      const mergedBids = filteredBids.map((b) => ({
        ...b,
        summary: cacheMap.get(b.id) ?? b.summary ?? '-',
      }));
      mergedSnapshot = mergeFetchedBidsWithPrevious(bidsRef.current, mergedBids);
      setBids(mergedSnapshot);
      bidsRef.current = mergedSnapshot;
      showToast(`동기화 완료: 이번에 반영된 채용대행·위탁 공고 ${mergedBids.length}건 (기존 목록과 병합)`);
    } catch (err) {
      console.error('handleRefresh error:', err);
      showToast('공고 데이터를 가져오는 데 실패했습니다. 기존 목록은 유지됩니다.');
    } finally {
      setIsLoading(false);
      setLoadingPhase('idle');
      if (!skipResultBackfill) {
        try {
          const base = mergedSnapshot ?? bidsRef.current;
          await refreshResultsForSelectedMonth(base, selectedMonth);
        } catch (e) {
          console.error('refreshResultsForSelectedMonth (handleRefresh finally):', e);
        }
      }
    }
  };

  function mergeAttachmentArrays(
    base: Array<{ name: string; url: string }> | undefined,
    extra: Array<{ name: string; url: string }> | undefined
  ) {
    const a = Array.isArray(base) ? base : [];
    const b = Array.isArray(extra) ? extra : [];
    const seen = new Set<string>();
    const out: Array<{ name: string; url: string }> = [];
    for (const f of [...a, ...b]) {
      const name = String(f?.name ?? '').trim();
      const url = String(f?.url ?? '').trim();
      if (!name || !url) continue;
      const key = `${name}||${url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, url });
    }
    return out;
  }

  const fetchHiddenProposalRequestAttachments = async () => {
    if (!selectedBid) {
      showToast('먼저 공고를 선택해 주세요.');
      return;
    }

    const targetId = String(selectedBid.id ?? '');
    const cacheKey = String(selectedBid.id ?? selectedBid.bidNtceNo ?? '');
    const baseFiles = selectedBid.files;
    const bidNo = String(selectedBid.bidNtceNo ?? '').trim();
    if (!bidNo) {
      showToast('이 공고는 나라장터 상세 연동에 필요한 bidNo가 없습니다.');
      return;
    }

    // 성공 캐시가 있으면 API 호출 없이 즉시 병합
    if (proposalFilesCacheRef.current.has(cacheKey)) {
      const cached = proposalFilesCacheRef.current.get(cacheKey) ?? [];
      if (!cached.length) {
        showToast('이 공고에는 연동된 제안요청서가 없습니다.');
        return;
      }
      const mergedFiles = mergeAttachmentArrays(baseFiles, cached);
      setBids((prev) => prev.map((b) => (b.id === targetId ? { ...b, files: mergedFiles } : b)));
      setSelectedBid((prev) =>
        prev && prev.id === targetId ? { ...prev, files: mergedFiles } : prev
      );
      showToast('숨은 제안요청서 첨부가 추가되었습니다.');
      return;
    }

    setProposalDetailLoadingBidId(cacheKey);
    try {
      const res = await fetch(
        `/api/g2b/detail?bidNo=${encodeURIComponent(String(bidNo))}&bidOrd=${encodeURIComponent(
          String(selectedBid.bidNtceOrd ?? '')
        )}&bfSpecRegNo=${encodeURIComponent(String(selectedBid?.bfSpecRegNo ?? ''))}`,
        { cache: 'no-store' }
      );

      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        const msg =
          (typeof errBody?.error === 'string' && errBody.error.trim()) || `API Error ${res.status}`;
        showToast(`연동 실패: ${msg}`);
        return;
      }

      const data = await res.json().catch(() => ({}));
      const proposalFilesRaw = Array.isArray(data?.proposalFiles) ? data.proposalFiles : [];
      const proposalFiles = proposalFilesRaw
        .map((f: any) => ({ name: String(f?.name ?? '').trim(), url: String(f?.url ?? '').trim() }))
        .filter((f) => f.name && f.url);

      if (proposalFiles.length === 0) {
        // 실패/없음은 캐시하지 않고, 사용자가 원하면 다시 시도할 수 있도록 둔다.
        showToast('이 공고에는 연동된 제안요청서가 없습니다.');
        return;
      }

      proposalFilesCacheRef.current.set(cacheKey, proposalFiles);
      const mergedFiles = mergeAttachmentArrays(baseFiles, proposalFiles);
      setBids((prev) => prev.map((b) => (b.id === targetId ? { ...b, files: mergedFiles } : b)));
      setSelectedBid((prev) =>
        prev && prev.id === targetId ? { ...prev, files: mergedFiles } : prev
      );
    } catch (e) {
      console.error('fetchHiddenProposalRequestAttachments error:', e);
      showToast('연동 중 오류가 발생했습니다.');
    } finally {
      setProposalDetailLoadingBidId((id) => (id === cacheKey ? null : id));
    }
  };

  /** 나라장터 상세(제안요청) 첨부 — 공고당 최대 1회 자동 호출, 실패 시 같은 세션에서 자동 재시도 없음 */
  const loadProposalDetailAttachmentsOnce = async (bid: any) => {
    if (!bid?.bidNtceNo) return;
    const cacheKey = String(bid.id ?? bid.bidNtceNo ?? '');

    if (proposalFilesCacheRef.current.has(cacheKey)) {
      const cached = proposalFilesCacheRef.current.get(cacheKey) ?? [];
      const mergedFiles = mergeAttachmentArrays(bid.files, cached);
      setBids((prev) =>
        prev.map((b) => (b.id === bid.id ? { ...b, files: mergedFiles } : b))
      );
      setSelectedBid((prev) =>
        prev && prev.id === bid.id ? { ...prev, files: mergedFiles } : prev
      );
      return;
    }

    if (proposalFilesFailedRef.current.has(cacheKey)) return;
    if (proposalFilesInFlightRef.current === cacheKey) return;

    proposalFilesInFlightRef.current = cacheKey;
    setProposalDetailLoadingBidId(cacheKey);

    try {
      const res = await fetch(
        `/api/g2b/detail?bidNo=${encodeURIComponent(String(bid.bidNtceNo))}&bidOrd=${encodeURIComponent(
          String(bid.bidNtceOrd ?? '')
        )}&bfSpecRegNo=${encodeURIComponent(String(bid?.bfSpecRegNo ?? ''))}`,
        { cache: 'no-store' }
      );
      if (!res.ok) {
        proposalFilesFailedRef.current.add(cacheKey);
        setProposalDetailUiTick((t) => t + 1);
        let msg = `나라장터 첨부 연동 실패 (${res.status})`;
        try {
          const errBody = await res.json();
          if (typeof errBody?.error === 'string' && errBody.error.trim()) {
            msg = errBody.error.trim();
          }
        } catch {
          /* ignore */
        }
        showToast(msg);
        return;
      }

      const data = await res.json().catch(() => ({}));
      const proposalFilesRaw = Array.isArray(data?.proposalFiles) ? data.proposalFiles : [];
      const proposalFiles = proposalFilesRaw
        .map((f: any) => ({
          name: String(f?.name ?? '').trim(),
          url: String(f?.url ?? '').trim(),
        }))
        .filter((f: any) => f.name && f.url);

      proposalFilesCacheRef.current.set(cacheKey, proposalFiles);
      if (proposalFiles.length === 0) {
        showToast('이 공고의 제안요청 첨부(나라장터 e-발주 연결)를 찾지 못했습니다.');
      }
      const mergedFiles = mergeAttachmentArrays(bid.files, proposalFiles);
      setBids((prev) =>
        prev.map((b) => (b.id === bid.id ? { ...b, files: mergedFiles } : b))
      );
      setSelectedBid((prev) =>
        prev && prev.id === bid.id ? { ...prev, files: mergedFiles } : prev
      );
    } catch (e) {
      console.error('proposalFiles fetch error:', e);
      proposalFilesFailedRef.current.add(cacheKey);
      setProposalDetailUiTick((t) => t + 1);
      showToast('나라장터 첨부 연동 중 오류가 발생했습니다. 자동 재시도하지 않습니다.');
    } finally {
      if (proposalFilesInFlightRef.current === cacheKey) {
        proposalFilesInFlightRef.current = null;
      }
      setProposalDetailLoadingBidId((id) => (id === cacheKey ? null : id));
    }
  };

  const handleSelectBidRow = (bid: any) => {
    setSelectedBid(bid);
  };

  const toggleBidRowExpand = (bid: any, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedBidId((prev) => (prev === bid.id ? null : bid.id));
  };

  // 펼침(expand) 시에는 무거운 /api/g2b/detail 호출을 하지 않는다.

  const handleUploadFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const added = e.target.files;
    if (!added || added.length === 0) {
      e.target.value = '';
      return;
    }
    const list = Array.from(added);
    const allowed = ['.pdf', '.hwpx', '.hwp'];
    const valid = list.filter((f) => {
      const name = (f.name || '').toLowerCase();
      return allowed.some((ext) => name.endsWith(ext));
    });
    if (valid.length === 0) {
      showToast('지원 형식이 아닙니다. .pdf, .hwpx, .hwp 파일만 선택해 주세요.');
      e.target.value = '';
      return;
    }
    if (valid.length < list.length) {
      showToast('일부만 추가됐습니다. .pdf, .hwpx, .hwp만 분석됩니다.');
    }
    setUploadFiles((prev) => [...prev, ...valid]);
    e.target.value = '';
  };

  const removeUploadFile = (index: number) => {
    setUploadFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleUploadAnalyze = async () => {
    if (!selectedBid) {
      showToast('먼저 공고를 선택해 주세요.');
      return;
    }
    if (uploadFiles.length === 0) {
      showToast('업로드할 첨부 파일을 선택해 주세요.');
      return;
    }
    const geminiKey = (geminiApiKey ?? '').trim();
    const activePrompt = prompts.find((p) => p.id === activePromptId) || prompts[0];
    const promptContent = activePrompt?.content ?? '';
    if (!geminiKey || !promptContent.trim()) {
      showToast('설정에서 Gemini API Key와 프롬프트를 먼저 저장해 주세요.');
      return;
    }
    const formData = new FormData();
    formData.append('bid', JSON.stringify(selectedBid));
    formData.append('prompt', promptContent);
    formData.append('geminiKey', geminiKey);
    uploadFiles.forEach((file) => {
      formData.append('files', file);
    });

    setIsAnalyzing(true);
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        const errMsg = data?.error ?? '업로드 기반 AI 분석에 실패했습니다.';
        const failSummary = `⚠️ 분석 실패: ${errMsg}`;
        showToast(errMsg);
        // 선택된 공고 및 리스트 상의 요약을 명시적으로 실패 메시지로 교체
        setBids((prev) =>
          prev.map((b) =>
            selectedBid && b.id === selectedBid.id ? { ...b, summary: failSummary } : b
          )
        );
        setSelectedBid((prev) =>
          prev && selectedBid && prev.id === selectedBid.id
            ? { ...prev, summary: failSummary }
            : prev
        );
        return;
      }
      const updatedBid = data?.bid;
      if (!updatedBid || !updatedBid.id) {
        showToast('업로드 기반 분석 결과 형식이 올바르지 않습니다.');
        return;
      }
      const newSummary = updatedBid.summary ?? '-';
      const summaryEmpty = !newSummary || newSummary === '-' || String(newSummary).trim() === '';
      setBids((prev) => prev.map((b) => (b.id === updatedBid.id ? { ...b, ...updatedBid } : b)));
      if (selectedBid && selectedBid.id === updatedBid.id) {
        setSelectedBid((prev) => (prev && prev.id === updatedBid.id ? { ...prev, ...updatedBid } : prev));
      }
      if (savedBidIds.has(updatedBid.id)) {
        const { error: upErr } = await supabase
          .from('saved_bids')
          .update({ summary: newSummary })
          .eq('bid_id', updatedBid.id);
        if (!upErr) {
          setSavedBidsData((rows) =>
            rows.map((r) =>
              r.bid_id === updatedBid.id ? { ...r, summary: newSummary } : r
            )
          );
        }
      }
      setUploadFiles([]);
      if (uploadInputRef.current) uploadInputRef.current.value = '';
      if (summaryEmpty) {
        showToast('파일에서 텍스트를 추출하지 못했거나 분석 결과가 비었습니다. PDF/hwpx/hwp 형식을 확인해 주세요.');
      } else {
        showToast('업로드한 첨부파일 기준으로 AI 재분석이 완료되었습니다.');
      }
      void fetchQuota();
    } catch (err) {
      console.error('handleUploadAnalyze error:', err);
      showToast('업로드 기반 AI 분석 중 오류가 발생했습니다.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleBatchAnalyze = async () => {
    showToast('이제 /api/analyze는 로컬 첨부파일 업로드 전용입니다. 개별 공고 우측 패널에서 업로드 후 재분석을 사용해 주세요.');
  };

  const toggleSaveBid = async (e, bid) => {
    e.stopPropagation();
    const isSaved = savedBidIds.has(bid.id);
    try {
      if (isSaved) {
        const { error } = await supabase.from('saved_bids').delete().eq('bid_id', bid.id);
        if (error) throw error;
        setSavedBidIds((prev) => {
          const next = new Set(prev);
          next.delete(bid.id);
          return next;
        });
        setSavedBidsData((prev) => prev.filter((r) => r.bid_id !== bid.id));
        showToast('보관함에서 제거되었습니다.');
      } else {
        const existing = savedBidsData.find((r) => r.bid_id === bid.id);
        const row = {
          bid_id: bid.id,
          title: bid.title ?? '',
          org: bid.org ?? '',
          notice_date: bid.noticeDate ?? null,
          deadline: bid.deadline ?? null,
          budget: bid.budget ?? '',
          status: bid.status ?? '',
          summary: bid.summary ?? '-',
          phone: bid.phone ?? null,
          email: bid.email ?? null,
          memo: existing?.memo ?? '',
          is_emailed: existing?.is_emailed ?? false,
        };
        const { error } = await supabase.from('saved_bids').upsert(row, { onConflict: 'bid_id' });
        if (error) throw error;
        setSavedBidIds((prev) => new Set(prev).add(bid.id));
        setSavedBidsData((prev) => {
          const others = prev.filter((r) => r.bid_id !== bid.id);
          return [...others, row].sort((a, b) =>
            compareBidsByNoticeDesc(
              { noticeDate: a.notice_date },
              { noticeDate: b.notice_date }
            )
          );
        });
        showToast('보관함에 저장되었습니다.');
      }
    } catch (err) {
      console.error('toggleSaveBid:', err);
      showToast(err instanceof Error ? err.message : '보관함 동기화에 실패했습니다.');
    }
  };

  const updatePipelineMemo = async (bidId: string, memo: string) => {
    const { error } = await supabase.from('saved_bids').update({ memo }).eq('bid_id', bidId);
    if (error) {
      console.error('saved_bids memo update:', error);
      showToast('메모 저장에 실패했습니다.');
      return;
    }
    setSavedBidsData((prev) =>
      prev.map((r) => (r.bid_id === bidId ? { ...r, memo } : r))
    );
  };

  const updatePipelineCeoFeedback = async (bidId: string, feedback: string) => {
    const { error } = await supabase
      .from('saved_bids')
      .update({ ceo_feedback: feedback })
      .eq('bid_id', bidId);
    if (error) {
      console.error('saved_bids ceo_feedback update:', error);
      showToast('대표님 피드백 저장에 실패했습니다.');
      return;
    }
    setSavedBidsData((prev) =>
      prev.map((r) => (r.bid_id === bidId ? { ...r, ceo_feedback: feedback } : r))
    );
  };

  const togglePipelineEmailed = async (bidId: string) => {
    const row = savedBidsData.find((r) => r.bid_id === bidId);
    const next = !row?.is_emailed;
    const { error } = await supabase
      .from('saved_bids')
      .update({ is_emailed: next })
      .eq('bid_id', bidId);
    if (error) {
      console.error('saved_bids is_emailed update:', error);
      showToast('발송 상태 변경에 실패했습니다.');
      return;
    }
    setSavedBidsData((prev) =>
      prev.map((r) => (r.bid_id === bidId ? { ...r, is_emailed: next } : r))
    );
  };

  const removeFromPipeline = async (bidId: string) => {
    const ok = window.confirm('정말 보관함에서 제거할까요? (파이프라인에서 삭제됩니다)');
    if (!ok) return;
    const { error } = await supabase.from('saved_bids').delete().eq('bid_id', bidId);
    if (error) {
      console.error('saved_bids delete error:', error);
      showToast('보관함에서 제거하는 데 실패했습니다.');
      return;
    }
    setSavedBidsData((prev) => prev.filter((r) => r.bid_id !== bidId));
    setSavedBidIds((prev) => {
      const next = new Set(prev);
      next.delete(bidId);
      return next;
    });
    if (pipelineSummaryModalBidId === bidId) setPipelineSummaryModalBidId(null);
    if (editingManualPhoneId === bidId) setEditingManualPhoneId(null);
    if (editingManualEmailId === bidId) setEditingManualEmailId(null);
    showToast('보관함에서 제거되었습니다.');
  };

  const togglePipelineCeoChecked = async (bidId: string) => {
    const row = savedBidsData.find((r) => r.bid_id === bidId);
    const next = !row?.is_ceo_checked;
    const { error } = await supabase
      .from('saved_bids')
      .update({ is_ceo_checked: next })
      .eq('bid_id', bidId);
    if (error) {
      console.error('saved_bids is_ceo_checked update:', error);
      showToast('대표님 확인 상태 변경에 실패했습니다.');
      return;
    }
    setSavedBidsData((prev) =>
      prev.map((r) => (r.bid_id === bidId ? { ...r, is_ceo_checked: next } : r))
    );
  };

  const updatePipelineManualContact = async (
    bidId: string,
    patch: { manual_phone?: string | null; manual_email?: string | null }
  ) => {
    const payload: any = {};
    if ('manual_phone' in patch) payload.manual_phone = patch.manual_phone;
    if ('manual_email' in patch) payload.manual_email = patch.manual_email;

    const { error } = await supabase.from('saved_bids').update(payload).eq('bid_id', bidId);
    if (error) {
      console.error('saved_bids manual contact update:', error);
      showToast('연락처 정보를 저장하는 데 실패했습니다.');
      return;
    }
    setSavedBidsData((prev) =>
      prev.map((r) =>
        r.bid_id === bidId
          ? {
              ...r,
              ...payload,
            }
          : r
      )
    );
  };

  const markFeedbackAsRead = async (bidId: string) => {
    const { error } = await supabase
      .from('saved_bids')
      .update({ is_feedback_read: true })
      .eq('bid_id', bidId);
    if (error) {
      console.error('saved_bids is_feedback_read update:', error);
      showToast('피드백 읽음 처리에 실패했습니다.');
      return;
    }
    setSavedBidsData((prev) =>
      prev.map((r) =>
        r.bid_id === bidId ? { ...r, is_feedback_read: true } : r
      )
    );
  };

  const markAllFeedbacksAsRead = async () => {
    const targets = savedBidsData.filter((row) => {
      const fb = row.ceo_feedback;
      const read = row.is_feedback_read === true;
      return fb != null && String(fb).trim() !== '' && !read;
    });
    if (targets.length === 0) return;
    const ids = targets.map((r) => r.bid_id);
    const { error } = await supabase
      .from('saved_bids')
      .update({ is_feedback_read: true })
      .in('bid_id', ids);
    if (error) {
      console.error('saved_bids bulk is_feedback_read update:', error);
      showToast('피드백 일괄 읽음 처리에 실패했습니다.');
      return;
    }
    setSavedBidsData((prev) =>
      prev.map((r) =>
        ids.includes(r.bid_id) ? { ...r, is_feedback_read: true } : r
      )
    );
  };

  const saveSettings = async () => {
    try {
      const { error: appSettingsError } = await supabase
        .from('app_settings')
        .upsert({
          id: 1,
          gemini_api_key: geminiApiKey,
        });

      if (appSettingsError) {
        console.error('app_settings 저장 오류:', appSettingsError);
        showToast('설정 저장 중 오류가 발생했습니다.');
        return;
      }

      const promptsWithIds = prompts.map((p) => {
        if (typeof p.id === 'number') {
          const newId = crypto.randomUUID();
          return { ...p, id: newId };
        }
        return p;
      });

      if (promptsWithIds.some((p, idx) => p.id !== prompts[idx].id)) {
        setPrompts(promptsWithIds);
        const currentActive = promptsWithIds.find((p) => p.id === activePromptId) || promptsWithIds[0];
        if (currentActive) {
          setActivePromptId(currentActive.id);
        }
      }

      const { error: promptsError } = await supabase
        .from('prompts')
        .upsert(
          promptsWithIds.map(({ id, title, content }) => ({
            id,
            title,
            content,
          }))
        );

      if (promptsError) {
        console.error('prompts 저장 오류:', promptsError);
        showToast('설정 저장 중 오류가 발생했습니다.');
        return;
      }

      showToast('설정이 데이터베이스에 안전하게 저장되었습니다.');
    } catch (error) {
      console.error('설정 저장 중 예외 발생:', error);
      showToast('설정 저장 중 오류가 발생했습니다.');
    }
  };

  const addNewPrompt = () => {
    const newId = crypto.randomUUID();
    setPrompts([...prompts, { id: newId, title: '새 프롬프트', content: '' }]);
    setActivePromptId(newId);
  };

  const deletePrompt = (id) => {
    if (prompts.length === 1) return alert('최소 1개의 프롬프트는 필요합니다.');
    const updated = prompts.filter(p => p.id !== id);
    setPrompts(updated);
    setActivePromptId(updated[0].id);
  };

  const updateActivePrompt = (field, value) => {
    setPrompts(prompts.map(p => p.id === activePromptId ? { ...p, [field]: value } : p));
  };

  const filteredBids = bids.filter(bid => {
    if (showSavedOnly && !savedBidIds.has(bid.id)) return false;
    if (searchKeyword && !bid.title.includes(searchKeyword) && !bid.org.includes(searchKeyword)) return false;
    return true;
  });

  const pipelineSorted = [...savedBidsData].sort((a, b) =>
    compareBidsByNoticeDesc(
      { noticeDate: a.notice_date },
      { noticeDate: b.notice_date }
    )
  );

  const getStatusBadge = (status) => {
    const styles = {
      '입찰서 접수중': 'bg-blue-50 text-blue-600 border-blue-100',
      '입찰 마감': 'bg-slate-100 text-slate-600 border-slate-200',
      '개찰완료': 'bg-emerald-50 text-emerald-600 border-emerald-100',
      '유찰': 'bg-red-50 text-red-600 border-red-100',
    };
    return <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${styles[status] || 'bg-gray-50 text-gray-600'}`}>{status}</span>;
  };

  const isYuchalResultStatus = (bid) => {
    const s = bid.result_status;
    if (s == null || s === '') return false;
    const t = String(s).trim();
    if (t === '유찰') return true;
    return /유찰/.test(t);
  };

  /** 입찰 상태 뱃지 옆: 유찰(빨강) 우선, 그다음 낙찰 업체명(초록) */
  const renderBidResultBadges = (bid) => {
    if (isYuchalResultStatus(bid)) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-red-100 text-red-700 border border-red-200/80">
          유찰
        </span>
      );
    }
    const w = bid.result_winner;
    if (w != null && String(w).trim() !== '' && String(w).trim() !== '-') {
      return (
        <span
          className="inline-flex items-center max-w-[160px] truncate px-2 py-0.5 rounded text-[10px] font-bold bg-green-100 text-green-700 border border-green-200/80"
          title={String(w).trim()}
        >
          {String(w).trim()}
        </span>
      );
    }
    return null;
  };

  return (
    <div className="bg-[#f1f5f9] font-sans text-slate-900 relative flex flex-col h-screen overflow-hidden">
      {toastMessage && (
        <div className="fixed bottom-6 right-6 bg-slate-900 text-white px-6 py-3 rounded-xl shadow-2xl flex items-center gap-3 z-50 animate-fade-in-up">
          <CheckCircle2 className="w-5 h-5 text-emerald-400" />
          <span className="text-sm font-bold">{toastMessage}</span>
        </div>
      )}

      <header className="bg-white border-b border-slate-200 px-8 py-4 flex items-center justify-between sticky top-0 z-30 shadow-sm shrink-0">
        <div className="flex items-center gap-4">
          <div className="bg-indigo-600 p-2 rounded-xl shadow-lg shadow-indigo-200"><Activity className="text-white w-5 h-5" /></div>
          <div><h1 className="text-lg font-black tracking-tight text-slate-800 uppercase">Venue Finder</h1><p className="text-[10px] text-slate-400 font-bold tracking-[0.2em]">SEOUL RECRUITMENT RADAR</p></div>
        </div>
        
        <div className="absolute left-1/2 -translate-x-1/2 flex items-center bg-slate-100 p-1 rounded-xl border border-slate-200 max-w-[min(100vw-2rem,520px)] flex-wrap justify-center">
          <button onClick={() => setActiveTab('dashboard')} className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all ${activeTab === 'dashboard' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}><Activity className="w-3.5 h-3.5" /> 대시보드</button>
          <button onClick={() => setActiveTab('pipeline')} className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all ${activeTab === 'pipeline' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}><BarChart3 className="w-3.5 h-3.5" /> 📊 영업 파이프라인</button>
          <button onClick={() => setActiveTab('settings')} className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all ${activeTab === 'settings' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}><Settings className="w-3.5 h-3.5" /> 시스템 설정</button>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center bg-slate-100 rounded-lg px-3 py-1.5 border border-slate-200 w-64 focus-within:ring-2 focus-within:ring-indigo-500 transition-all"><Search className="w-3.5 h-3.5 text-slate-400 mr-2" /><input type="text" placeholder="검색어 입력 (예: 예금보험)" value={searchKeyword} onChange={(e) => setSearchKeyword(e.target.value)} className="bg-transparent border-none focus:outline-none text-xs font-bold text-slate-700 w-full placeholder-slate-400" /></div>
          <div className="w-px h-5 bg-slate-200 mx-1"></div>
          <div className="flex items-center bg-slate-100 rounded-lg px-3 py-1.5 border border-slate-200"><Calendar className="w-3.5 h-3.5 text-slate-500 mr-2" /><input type="month" value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)} className="bg-transparent border-none focus:outline-none text-xs font-bold text-slate-700 w-32" /></div>
          <button type="button" onClick={() => void handleRefresh(false)} disabled={isLoading} className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white px-4 py-2 rounded-lg text-xs font-bold transition-all disabled:opacity-70 disabled:cursor-not-allowed"><RefreshCcw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} /> API 최신화</button>
          <button onClick={handleBatchAnalyze} disabled={isAnalyzing || isLoading} className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-xs font-bold transition-all disabled:opacity-70 disabled:cursor-not-allowed">{isAnalyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '✨'} 미분석 공고 AI 분석</button>
        </div>
      </header>

      {activeTab === 'dashboard' ? (
        <main className="flex flex-1 overflow-hidden w-full h-full">
          <div className="flex-1 h-full overflow-y-auto p-6 scrollbar-hide">
            <div className="bg-slate-50 border border-slate-200 rounded-2xl px-6 py-3 flex items-center justify-end relative z-20 mb-4">
              <div className="flex bg-slate-200 p-0.5 rounded-lg border border-slate-300">
                <button onClick={() => setShowSavedOnly(false)} className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] font-bold transition-all ${!showSavedOnly ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}><List className="w-3 h-3" /> 전체 공고</button>
                <button onClick={() => setShowSavedOnly(true)} className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] font-bold transition-all ${showSavedOnly ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}><Bookmark className="w-3 h-3" /> 보관함 ({savedBidIds.size})</button>
              </div>
            </div>

            {isLoading && (
              <div className="mb-4 flex items-center justify-center gap-3 rounded-2xl bg-indigo-50 border border-indigo-100 px-6 py-4">
                <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin text-indigo-600" />
                <span className="text-sm font-bold text-indigo-800">데이터 수집 중...</span>
              </div>
            )}

            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
              <div className="p-4 border-b border-slate-100 bg-white flex justify-between items-center">
                <h2 className="text-sm font-black text-slate-700 flex items-center gap-2"><FileText className="w-4 h-4 text-indigo-600" />{showSavedOnly ? '내 보관함' : '서울 지역 입찰 공고'}</h2>
                <div className="text-[10px] font-bold text-slate-400 uppercase">Total: {filteredBids.length} Cases</div>
              </div>
              <div className="flex-1 overflow-auto">
                <table className="w-full text-left border-separate border-spacing-0">
                  <thead className="bg-slate-50 sticky top-0 z-10">
                    <tr>
                      <th className="px-5 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100"></th>
                      <th className="px-5 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">공고 정보 / 기관</th>
                      <th className="px-5 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100 text-center">일정 및 상태</th>
                      <th className="px-5 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100 text-right">예산 및 규모</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {filteredBids.map((bid) => {
                      const isSaved = savedBidIds.has(bid.id);
                      const isAnalyzed = analyzedBidIds.has(bid.id);
                      const isExpanded = expandedBidId === bid.id;
                      return (
                        <React.Fragment key={bid.id}>
                          <tr
                            onClick={() => handleSelectBidRow(bid)}
                            className={`group cursor-pointer transition-colors ${selectedBid?.id === bid.id ? 'bg-indigo-50/50' : hasRealSummary(bid) ? 'bg-yellow-50' : 'bg-white'} ${isAnalyzed ? 'opacity-70' : ''} hover:opacity-90`}
                          >
                            <td className="px-5 py-4 w-14">
                              <div className="flex flex-col items-center gap-2">
                                <button
                                  type="button"
                                  onClick={(e) => toggleBidRowExpand(bid, e)}
                                  title={isExpanded ? '행 접기' : '펼쳐서 첨부파일 보기'}
                                  className={`p-1 rounded-md border transition-colors ${isExpanded ? 'bg-indigo-100 border-indigo-200 text-indigo-700' : 'bg-white border-slate-200 text-slate-400 hover:border-indigo-200 hover:text-indigo-600'}`}
                                >
                                  <ChevronDown
                                    className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                                  />
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); void toggleAnalyzedStatus(bid.id); }}
                                  title={isAnalyzed ? '분석 완료' : '분석 전'}
                                  className={`p-1.5 rounded-full border transition-colors ${isAnalyzed ? 'bg-emerald-50 border-emerald-200' : 'bg-white border-slate-200 hover:border-slate-300'}`}
                                >
                                  <CheckCircle2 className={`w-5 h-5 ${isAnalyzed ? 'text-emerald-600 fill-emerald-200' : 'text-slate-300'}`} />
                                </button>
                                <button type="button" onClick={(e) => toggleSaveBid(e, bid)} className="text-slate-300 hover:text-indigo-500 transition-colors">{isSaved ? <BookmarkCheck className="w-5 h-5 text-indigo-600 fill-indigo-100" /> : <Bookmark className="w-5 h-5" />}</button>
                              </div>
                            </td>
                            <td className="px-5 py-4"><div className="font-bold text-slate-800 text-sm group-hover:text-indigo-600 transition-colors line-clamp-1">{bid.title}</div><div className="flex items-center text-[11px] text-slate-400 font-bold mt-1"><Building2 className="w-3 h-3 mr-1 text-slate-300" /> {bid.org}</div></td>
                            <td className="px-5 py-4 text-center">
                              <div className="flex flex-col items-center gap-1.5">
                                <div className="text-[10px] font-bold text-slate-400">게시일: {bid.noticeDate ?? '-'}</div>
                                <div className="flex items-center text-[11px] font-bold text-slate-600">
                                  <Calendar className="w-3 h-3 mr-1 text-slate-400" />
                                  {bid.deadline}
                                </div>
                                <div className="flex flex-wrap items-center justify-center gap-1.5">
                                  {getStatusBadge(bid.status)}
                                  {renderBidResultBadges(bid)}
                                </div>
                              </div>
                            </td>
                            <td className="px-5 py-4 text-right"><div className="text-sm font-black text-slate-800">{bid.budget}</div><div className="text-[10px] text-slate-400 font-bold mt-1 flex items-center justify-end"><Users className="w-3 h-3 mr-1" /> {bid.scale}</div></td>
                          </tr>
                          {isExpanded && (
                            <tr className="bg-slate-50/90 border-b border-slate-100">
                              <td colSpan={4} className="px-5 py-4 text-left">
                                <div className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2">나라장터 제안요청·추가 첨부 (목록 파일)</div>
                                {((bid.files) ?? []).length === 0 ? (
                                  <p className="text-xs text-slate-500 font-medium">목록 API에 첨부가 없습니다.</p>
                                ) : (
                                  <ul className="space-y-1 max-h-40 overflow-y-auto">
                                    {(bid.files ?? []).map((file, idx) => (
                                      <li key={idx}>
                                        <a
                                          href={file.url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-xs font-medium text-indigo-600 hover:underline break-all"
                                          onClick={(e) => e.stopPropagation()}
                                        >
                                          {file.name}
                                        </a>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                    {filteredBids.length === 0 && (<tr><td colSpan="4" className="text-center py-12 text-slate-400 text-sm font-bold">표시할 공고가 없습니다.</td></tr>)}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="w-[450px] shrink-0 h-full overflow-y-auto p-6 border-l bg-gray-50/50 scrollbar-hide">
            <div className="flex flex-col gap-5">
              {selectedBid ? (
                <>
                  <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
                    <div className="flex items-center justify-between mb-6 border-b border-slate-100 pb-4">
                      <div>
                        <p className="text-[10px] text-slate-400 font-bold mb-1">공고번호: {selectedBid.id}</p>
                        <div className="flex items-center gap-2"><div className="w-7 h-7 bg-indigo-50 rounded flex items-center justify-center"><Search className="text-indigo-600 w-4 h-4" /></div><h2 className="text-sm font-black text-slate-800 uppercase tracking-tight">AI 과업 분석 보고서</h2></div>
                      </div>
                      <button onClick={(e) => toggleSaveBid(e, selectedBid)} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${savedBidIds.has(selectedBid.id) ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{savedBidIds.has(selectedBid.id) ? <BookmarkCheck className="w-4 h-4" /> : <Bookmark className="w-4 h-4" />}{savedBidIds.has(selectedBid.id) ? '보관됨' : '보관하기'}</button>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-3 mb-6">
                      <div className="bg-slate-50/80 p-3 rounded-xl border border-slate-100"><p className="text-[9px] font-black text-slate-400 uppercase mb-1">마감일자</p><p className="text-xs font-bold text-slate-700">{selectedBid.deadline}</p></div>
                      <div className="bg-slate-50/80 p-3 rounded-xl border border-slate-100"><p className="text-[9px] font-black text-slate-400 uppercase mb-1">사업예산</p><p className="text-xs font-bold text-indigo-600">{selectedBid.budget}</p></div>
                      <div className="bg-slate-50/80 p-3 rounded-xl border border-slate-100"><p className="text-[9px] font-black text-slate-400 uppercase mb-1">채용인원</p><p className="text-xs font-bold text-slate-700">{selectedBid.scale}</p></div>
                      <div className="bg-slate-50/80 p-3 rounded-xl border border-slate-100"><p className="text-[9px] font-black text-slate-400 uppercase mb-1">주요장소</p><p className="text-xs font-bold text-slate-700 truncate" title={selectedBid.venue}>{selectedBid.venue}</p></div>
                      {selectedBid.estimatedPrice && selectedBid.estimatedPrice !== '-' && (
                        <div className="col-span-2 bg-slate-50/80 p-3 rounded-xl border border-slate-100"><p className="text-[9px] font-black text-slate-400 uppercase mb-1">추정가격</p><p className="text-xs font-bold text-slate-700">{selectedBid.estimatedPrice}</p></div>
                      )}
                    </div>

                    <div className="mb-6">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2 text-indigo-600"><FileText className="w-3.5 h-3.5" /><span className="text-[10px] font-black uppercase tracking-widest">과업 내용 상세정리</span></div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-slate-400 font-medium">클릭 시 전체 보기</span>
                          {selectedBid?.id && editingSummaryBidId !== selectedBid.id ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                startEditingSummary(selectedBid.id, selectedBid.summary);
                              }}
                              className="px-2 py-1 rounded-lg text-[10px] font-black border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                            >
                              편집
                            </button>
                          ) : null}
                        </div>
                      </div>
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          if (selectedBid?.id && editingSummaryBidId === selectedBid.id) return;
                          setSummaryModalOpen(true);
                        }}
                        onKeyDown={(e) => {
                          if (selectedBid?.id && editingSummaryBidId === selectedBid.id) return;
                          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSummaryModalOpen(true); }
                        }}
                        className="w-full text-left text-xs text-slate-600 leading-relaxed font-medium bg-indigo-50/30 p-4 rounded-xl border border-indigo-100/30 break-words [&>strong]:font-bold [&>strong]:text-slate-800 max-h-80 overflow-y-auto cursor-pointer hover:bg-indigo-50/50 hover:border-indigo-200/50 transition-colors"
                      >
                        {selectedBid?.id && editingSummaryBidId === selectedBid.id ? (
                          <div
                            className="space-y-2"
                            onClick={(e) => e.stopPropagation()}
                            onMouseDown={(e) => e.stopPropagation()}
                          >
                            <textarea
                              ref={summaryTextareaRef}
                              value={editingSummaryDraft}
                              onChange={(e) => {
                                setEditingSummaryDraft(e.target.value);
                                e.target.style.height = 'auto';
                                e.target.style.height = `${Math.max(e.target.scrollHeight, 120)}px`;
                              }}
                              onClick={(e) => e.stopPropagation()}
                              onMouseDown={(e) => e.stopPropagation()}
                              className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-xs font-medium text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/25 focus:border-indigo-300 resize-y min-h-[120px]"
                            />
                            <div className="flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void saveEditedSummary(selectedBid.id);
                                }}
                                className="px-3 py-1.5 rounded-lg text-[10px] font-black bg-indigo-600 text-white hover:bg-indigo-700"
                              >
                                저장
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  cancelEditingSummary();
                                }}
                                className="px-3 py-1.5 rounded-lg text-[10px] font-black border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                              >
                                취소
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div dangerouslySetInnerHTML={{ __html: renderSummaryHtml(selectedBid.summary) }} />
                        )}
                      </div>
                    </div>

                    {summaryModalOpen && (
                      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" aria-modal="true" role="dialog">
                        <div className="absolute inset-0 bg-black/40" onClick={() => setSummaryModalOpen(false)} />
                        <div className="relative bg-white rounded-2xl border border-slate-200 shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
                          <div className="flex items-center justify-between p-4 border-b border-slate-100">
                            <span className="text-sm font-black text-slate-800">과업 내용 상세정리</span>
                            <button type="button" onClick={() => setSummaryModalOpen(false)} className="p-2 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100"><X className="w-5 h-5" /></button>
                          </div>
                          <div
                            className="flex-1 overflow-y-auto p-5 text-xs text-slate-600 leading-relaxed font-medium break-words [&>strong]:font-bold [&>strong]:text-slate-800"
                            dangerouslySetInnerHTML={{ __html: renderSummaryHtml(selectedBid.summary) }}
                          />
                        </div>
                      </div>
                    )}

                    <div className="mb-6">
                      <div className="flex items-center gap-2 mb-2 text-slate-600"><Download className="w-3.5 h-3.5" /><span className="text-[10px] font-black uppercase tracking-widest">첨부문서 다운로드</span></div>
                      <p className="text-[10px] text-slate-400 font-medium mb-2 leading-relaxed">
                        기본은 목록 API의 일반 첨부파일만 표시됩니다. e-발주(제안요청) 숨은 첨부는 아래의 <strong className="text-slate-600">[🔍 숨은 제안요청서 가져오기]</strong> 버튼을 눌렀을 때만 1회 탐색합니다.
                      </p>
                      <div className="space-y-1.5">
                        {((selectedBid.files) ?? []).length === 0 ? (
                          <p className="text-[11px] text-slate-400 font-medium py-2">첨부문서가 없습니다.</p>
                        ) : (
                          (selectedBid.files ?? []).map((file, idx) => {
                            const keyWords = ['과업', '제안', '공고', '지시', '안내', '규격'];
                            const isKeyDoc = keyWords.some((kw) => file.name && file.name.includes(kw));
                            return (
                              <a key={idx} href={file.url} target="_blank" rel="noopener noreferrer" className={`flex items-center gap-2 w-full p-2.5 rounded-xl border transition-all hover:bg-slate-50 ${isKeyDoc ? 'border-indigo-200 bg-indigo-50/50' : 'border-slate-100 bg-slate-50/50'}`}>
                                {isKeyDoc ? <FileText className="w-4 h-4 text-indigo-600 flex-shrink-0" /> : <Download className="w-4 h-4 text-slate-400 flex-shrink-0" />}
                                <span className={`text-xs truncate flex-1 ${isKeyDoc ? 'font-bold text-indigo-700' : 'font-medium text-slate-500'}`} title={file.name}>{file.name}</span>
                              </a>
                            );
                          })
                        )}
                      </div>

                      <div className="mt-3">
                        <button
                          type="button"
                          onClick={() => void fetchHiddenProposalRequestAttachments()}
                          disabled={
                            proposalDetailLoadingBidId ===
                            String(selectedBid.id ?? selectedBid.bidNtceNo ?? '')
                          }
                          className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-[11px] font-bold bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-70 disabled:cursor-not-allowed"
                          title="클릭하면 /api/g2b/detail 로 e-발주(제안요청) 첨부를 한 번 탐색합니다."
                        >
                          {proposalDetailLoadingBidId ===
                          String(selectedBid.id ?? selectedBid.bidNtceNo ?? '') ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              가져오는 중…
                            </>
                          ) : (
                            '🔍 숨은 제안요청서 가져오기 (e-발주 연동)'
                          )}
                        </button>
                      </div>
                    </div>

                    <div className="mb-6">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-[16px]">☁️</div>
                          <div>
                            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">HWP 자동 변환 무료 크레딧</p>
                            <p className="text-xs font-semibold text-slate-700 mt-0.5">CloudConvert 남은 일일 한도</p>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-2xl font-black text-indigo-600 leading-none">
                            {ccQuota == null ? '로딩중…' : ccQuota}
                          </div>
                          <div className="text-[10px] font-bold text-slate-400 mt-0.5">credits</div>
                        </div>
                      </div>
                      <p className="text-[11px] text-slate-400 font-medium">
                        * CloudConvert 무료 전환 한도는 계정 정책 기준(현재 일 최대 10회) · `credits`는 남은 변환 크레딧입니다.
                      </p>
                    </div>

                    <div className="mb-6">
                      <div className="flex items-center gap-2 mb-2 text-emerald-600">
                        <FileText className="w-3.5 h-3.5" />
                        <span className="text-[10px] font-black uppercase tracking-widest">로컬 첨부파일 업로드 후 재분석</span>
                      </div>
                      <p className="text-[11px] text-slate-500 font-medium mb-2">
                        조달청 서버에서 첨부파일 다운로드가 차단될 경우, 아래에서 직접 내려받은 파일(.pdf, .hwpx, .hwp)을 선택해 추가한 뒤 업로드하면 해당 공고 기준으로 다시 분석합니다.
                      </p>
                      <div className="flex flex-col gap-2">
                        <input
                          ref={uploadInputRef}
                          type="file"
                          multiple
                          onChange={handleUploadFileChange}
                          className="block w-full text-[11px] text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-[11px] file:font-bold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100"
                        />
                        {uploadFiles.length > 0 && (
                          <ul className="space-y-1.5">
                            {uploadFiles.map((file, idx) => (
                              <li key={idx} className="flex items-center gap-2 p-2 rounded-lg bg-slate-50 border border-slate-100">
                                <FileText className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                                <span className="text-xs font-medium text-slate-700 truncate flex-1" title={file.name}>{file.name}</span>
                                <button type="button" onClick={() => removeUploadFile(idx)} className="p-1 rounded text-slate-400 hover:text-red-500 hover:bg-red-50" title="제거"><X className="w-3.5 h-3.5" /></button>
                              </li>
                            ))}
                          </ul>
                        )}
                        <button
                          type="button"
                          onClick={handleUploadAnalyze}
                          disabled={isAnalyzing}
                          className="inline-flex items-center justify-center px-3 py-1.5 rounded-lg text-[11px] font-bold bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-70 disabled:cursor-not-allowed"
                        >
                          {isAnalyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}
                          업로드한 첨부파일로 AI 재분석
                        </button>
                      </div>
                    </div>

                    <div className="pt-5 border-t border-slate-100">
                      <div className="flex items-center justify-between mb-3"><div className="flex items-center gap-2 text-emerald-600"><Trophy className="w-3.5 h-3.5" /><span className="text-[10px] font-black uppercase tracking-widest">실시간 개찰 결과</span></div><span className="text-[9px] font-bold text-slate-300 italic">Live Update</span></div>
                      {bidResult?.status === '유찰' ? (
                        <div className="rounded-xl p-4 bg-red-50 border border-red-200">
                          <p className="text-sm font-black text-red-700">유찰</p>
                          <p className="text-[11px] font-medium text-red-600 mt-1">해당 공고는 유찰 처리되었습니다.</p>
                        </div>
                      ) : bidResult?.status === '개찰완료' ? (
                        <div className="flex items-center justify-between bg-slate-900 rounded-xl p-4 text-white">
                          <div><p className="text-[9px] font-bold text-slate-400 mb-0.5">최종 낙찰업체</p><p className="text-xs font-black">{bidResult.winner}</p></div>
                          <div className="text-right"><p className="text-[9px] font-bold text-slate-400 mb-0.5">낙찰 금액</p><p className="text-xs font-black text-emerald-400">{bidResult.amount}</p></div>
                        </div>
                      ) : bidResult?.status && bidResult.status !== '-' ? (
                        <div className="rounded-xl p-4 bg-slate-100 border border-slate-200">
                          <p className="text-sm font-bold text-slate-700">{bidResult.status}</p>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between bg-slate-900 rounded-xl p-4 text-white">
                          <div><p className="text-[9px] font-bold text-slate-400 mb-0.5">최종 낙찰업체</p><p className="text-xs font-black">{selectedBid.result?.winner ?? '-'}</p></div>
                          <div className="text-right"><p className="text-[9px] font-bold text-slate-400 mb-0.5">낙찰 금액</p><p className="text-xs font-black text-emerald-400">{selectedBid.result?.price !== '-' && selectedBid.result?.price ? selectedBid.result.price : '-'}</p></div>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 overflow-hidden relative">
                    <div className="absolute -top-6 -right-6 w-24 h-24 bg-indigo-50 rounded-full opacity-50"></div>
                    <div className="flex items-center gap-2 mb-5 relative z-10"><User className="text-indigo-600 w-4 h-4" /><h2 className="text-sm font-black text-slate-800 uppercase tracking-tight">주관부서 문의처</h2></div>
                    <div className="space-y-3 relative z-10">
                      <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl border border-slate-100">
                        <div className="w-10 h-10 bg-indigo-600 text-white rounded-lg flex items-center justify-center font-black text-sm">{selectedBid.manager[0]}</div>
                        <div><p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">{selectedBid.dept}</p><p className="text-sm font-bold text-slate-800">{selectedBid.manager}</p></div>
                      </div>
                      <div className="grid grid-cols-1 gap-2">
                        <a href={`tel:${selectedBid.phone}`} className="flex items-center justify-between p-3 bg-white border border-slate-100 rounded-xl hover:border-indigo-200 hover:bg-indigo-50 transition-all"><div className="flex items-center gap-3"><Phone className="w-3.5 h-3.5 text-slate-400" /><span className="text-xs font-bold text-slate-700">{selectedBid.phone}</span></div><ChevronRight className="w-3 h-3 text-slate-200" /></a>
                        <a href={`mailto:${selectedBid.email}`} className="flex items-center justify-between p-3 bg-white border border-slate-100 rounded-xl hover:border-indigo-200 hover:bg-indigo-50 transition-all"><div className="flex items-center gap-3"><Mail className="w-3.5 h-3.5 text-slate-400" /><span className="text-xs font-bold text-slate-700">{selectedBid.email}</span></div><ChevronRight className="w-3 h-3 text-slate-200" /></a>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex-1 bg-white rounded-2xl border border-dashed border-slate-300 flex flex-col items-center justify-center p-12 text-center opacity-50"><div className="w-16 h-16 bg-slate-50 rounded-2xl flex items-center justify-center mb-4"><Search className="text-slate-200 w-8 h-8" /></div><h3 className="text-slate-400 font-black text-sm mb-1">공고를 선택해 주세요</h3><p className="text-slate-300 text-[11px] font-medium leading-relaxed">좌측 목록에서 공고를 선택하면<br />상세 분석 리포트가 생성됩니다.</p></div>
              )}
            </div>
          </div>
        </main>
      ) : activeTab === 'pipeline' ? (
        <main className="flex-1 p-8 overflow-hidden bg-gradient-to-b from-slate-100/90 via-slate-50 to-white min-h-0">
          <div className="flex flex-row items-start gap-6 w-full h-[calc(100vh-140px)]">
            <div className="flex-1 h-full overflow-y-auto pr-2 flex flex-col gap-6">
              <div className="max-w-4xl w-full space-y-8 pb-12">
                <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.25em] text-indigo-500 mb-1">Sales Pipeline</p>
                    <h2 className="text-2xl font-black text-slate-900 tracking-tight">영업 파이프라인</h2>
                    <p className="text-sm font-medium text-slate-500 mt-1">보관한 공고를 한눈에 — 예산·AI 요약·영업 메모를 카드로 관리합니다.</p>
                  </div>
                  <div className="flex items-center gap-2 rounded-2xl bg-white/90 border border-slate-200/80 px-4 py-2.5 shadow-sm">
                    <span className="text-[11px] font-bold text-slate-400 uppercase">저장</span>
                    <span className="text-xl font-black text-indigo-600">{pipelineSorted.length}</span>
                    <span className="text-xs font-bold text-slate-500">건</span>
                  </div>
                </div>
                {pipelineSorted.length === 0 ? (
                  <div className="rounded-3xl border border-dashed border-slate-300 bg-white/70 px-8 py-16 text-center shadow-inner">
                    <Bookmark className="w-12 h-12 text-slate-200 mx-auto mb-4" />
                    <p className="text-slate-600 font-bold">아직 파이프라인에 저장된 공고가 없습니다.</p>
                    <p className="text-sm text-slate-400 mt-2 font-medium">대시보드에서 북마크로 보관하면 이곳에 표시됩니다.</p>
                  </div>
                ) : (
                  <ul className="space-y-6">
                    {pipelineSorted.map((row) => {
                  const effectivePhone =
                    row.manual_phone && String(row.manual_phone).trim() !== ''
                      ? row.manual_phone
                      : row.phone;
                  const effectiveEmail =
                    row.manual_email && String(row.manual_email).trim() !== ''
                      ? row.manual_email
                      : row.email;
                  const phoneOk =
                    effectivePhone &&
                    String(effectivePhone).trim() !== '' &&
                    effectivePhone !== '-';
                  const emailOk =
                    effectiveEmail &&
                    String(effectiveEmail).trim() !== '' &&
                    effectiveEmail !== '-';
                  const emailed = row.is_emailed === true;
                  const ceoChecked = row.is_ceo_checked === true;
                  return (
                    <li
                      key={row.bid_id}
                      id={`pipeline-${row.bid_id}`}
                      className={`rounded-3xl border bg-white shadow-[0_8px_30px_rgb(15,23,42,0.06)] hover:shadow-[0_14px_44px_rgb(15,23,42,0.09)] transition-shadow duration-300 overflow-hidden ${
                        selectedPipelineBidId === row.bid_id
                          ? 'border-indigo-300 ring-2 ring-indigo-200'
                          : 'border-slate-200/90'
                      }`}
                    >
                      <div className="px-6 pt-6 pb-5 border-b border-slate-100/90 bg-gradient-to-r from-white to-slate-50/60">
                        <div className="flex items-start justify-between gap-4">
                          <div className="space-y-1">
                            <p className="text-sm sm:text-base font-semibold text-slate-600 flex items-center gap-2">
                              <Calendar className="w-4 h-4 text-slate-500" />
                              <span>게시 {row.notice_date ?? '-'}</span>
                            </p>
                            <p className="text-sm sm:text-lg font-semibold text-slate-700 flex items-center gap-2">
                              <Building2 className="w-4 h-4 text-indigo-500" />
                              <span>{row.org ?? '-'}</span>
                            </p>
                            <p className="text-[11px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest">
                              공고번호: {row.notice_number ?? row.bid_id}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => void togglePipelineCeoChecked(row.bid_id)}
                            className={`inline-flex flex-col items-end px-3 py-2 rounded-xl border text-[10px] font-bold gap-1 transition-all ${
                              ceoChecked
                                ? 'bg-emerald-50 border-emerald-200 text-emerald-800 shadow-sm'
                                : 'bg-white/60 border-slate-200 text-slate-500 hover:border-emerald-200 hover:bg-emerald-50/40'
                            }`}
                          >
                            <span className="inline-flex items-center gap-1">
                              <CheckCircle2
                                className={`w-3.5 h-3.5 ${
                                  ceoChecked ? 'text-emerald-600' : 'text-slate-300'
                                }`}
                              />
                              <span>{ceoChecked ? '대표님 확인 완료' : '대표님 확인'}</span>
                            </span>
                            {ceoChecked && (
                              <span className="text-[9px] font-medium text-emerald-600">
                                ✅ 최종 검토됨
                              </span>
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => void removeFromPipeline(row.bid_id)}
                            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border text-[10px] font-bold bg-white/70 border-slate-200 text-slate-500 hover:bg-red-50 hover:border-red-200 hover:text-red-700 transition-colors"
                            title="보관함에서 제거"
                          >
                            <X className="w-4 h-4" />
                            보관함에서 제거
                          </button>
                        </div>
                        <h3 className="mt-4 text-2xl sm:text-3xl font-extrabold text-slate-900 leading-snug tracking-tight pr-1">
                          {row.title ?? '-'}
                        </h3>
                      </div>
                      <div className="px-6 py-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="rounded-2xl bg-slate-50/95 border border-slate-100 p-4 sm:col-span-2">
                          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">사업 예산</p>
                          <p className="text-2xl sm:text-3xl font-black text-indigo-600 tracking-tight">{row.budget ?? '-'}</p>
                        </div>
                        <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
                          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">입찰 마감</p>
                          <p className="text-sm font-bold text-slate-800">{row.deadline ?? '-'}</p>
                        </div>
                        <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm flex flex-col gap-2 justify-center">
                          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">상태</p>
                          <div>{getStatusBadge(row.status)}</div>
                        </div>
                      </div>
                      <div className="px-6 pb-2">
                        <div className="flex flex-wrap gap-2 mb-4">
                          {editingManualPhoneId === row.bid_id ? (
                            <input
                              autoFocus
                              type="tel"
                              defaultValue={row.manual_phone ?? ''}
                              onBlur={(e) => {
                                const value = e.target.value.trim();
                                void updatePipelineManualContact(row.bid_id, {
                                  manual_phone: value || null,
                                });
                                setEditingManualPhoneId(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  const value = (e.target as HTMLInputElement).value.trim();
                                  void updatePipelineManualContact(row.bid_id, {
                                    manual_phone: value || null,
                                  });
                                  setEditingManualPhoneId(null);
                                } else if (e.key === 'Escape') {
                                  setEditingManualPhoneId(null);
                                }
                              }}
                              className="inline-flex items-center rounded-xl px-3 py-2 text-xs font-bold border bg-white border-amber-300 text-slate-800 focus:outline-none focus:ring-2 focus:ring-amber-400/40"
                              placeholder="담당 연락처 입력"
                            />
                          ) : phoneOk ? (
                            <a
                              href={`tel:${String(effectivePhone).replace(/\s/g, '')}`}
                              className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-bold border bg-amber-50 border-amber-200 text-amber-950 hover:bg-amber-100 transition-colors"
                            >
                              <Phone className="w-3.5 h-3.5 shrink-0" />
                              담당 {effectivePhone}
                            </a>
                          ) : null}
                          {editingManualEmailId === row.bid_id ? (
                            <input
                              autoFocus
                              type="email"
                              defaultValue={row.manual_email ?? ''}
                              onBlur={(e) => {
                                const value = e.target.value.trim();
                                void updatePipelineManualContact(row.bid_id, {
                                  manual_email: value || null,
                                });
                                setEditingManualEmailId(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  const value = (e.target as HTMLInputElement).value.trim();
                                  void updatePipelineManualContact(row.bid_id, {
                                    manual_email: value || null,
                                  });
                                  setEditingManualEmailId(null);
                                } else if (e.key === 'Escape') {
                                  setEditingManualEmailId(null);
                                }
                              }}
                              className="inline-flex items-center rounded-xl px-3 py-2 text-xs font-bold border bg-white border-sky-300 text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
                              placeholder="이메일 입력"
                            />
                          ) : emailOk ? (
                            <a
                              href={`mailto:${effectiveEmail}`}
                              className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-bold border bg-sky-50 border-sky-200 text-sky-950 hover:bg-sky-100 transition-colors"
                            >
                              <Mail className="w-3.5 h-3.5 shrink-0" />
                              {effectiveEmail}
                            </a>
                          ) : null}
                        </div>
                        <div className="rounded-2xl bg-indigo-50/95 border border-indigo-100/90 p-5 shadow-inner">
                          <div className="flex items-center justify-between gap-2 mb-2">
                            <FileText className="w-4 h-4 text-indigo-600 shrink-0" />
                            <span className="text-[10px] font-black uppercase tracking-widest text-indigo-800 flex-1">AI 분석 요약</span>
                            {editingSummaryBidId !== row.bid_id ? (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  startEditingSummary(row.bid_id, row.summary);
                                }}
                                className="px-2 py-1 rounded-lg text-[10px] font-black border border-indigo-200 bg-white text-indigo-700 hover:bg-indigo-50"
                              >
                                편집
                              </button>
                            ) : null}
                          </div>
                          {editingSummaryBidId === row.bid_id ? (
                            <div
                              className="space-y-2"
                              onClick={(e) => e.stopPropagation()}
                              onMouseDown={(e) => e.stopPropagation()}
                            >
                              <textarea
                                ref={summaryTextareaRef}
                                value={editingSummaryDraft}
                                onChange={(e) => {
                                  setEditingSummaryDraft(e.target.value);
                                  e.target.style.height = 'auto';
                                  e.target.style.height = `${Math.max(e.target.scrollHeight, 120)}px`;
                                }}
                                onClick={(e) => e.stopPropagation()}
                                onMouseDown={(e) => e.stopPropagation()}
                                className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-xs font-medium text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/25 focus:border-indigo-300 resize-y min-h-[120px]"
                              />
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void saveEditedSummary(row.bid_id);
                                  }}
                                  className="px-3 py-1.5 rounded-lg text-[10px] font-black bg-indigo-600 text-white hover:bg-indigo-700"
                                >
                                  저장
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    cancelEditingSummary();
                                  }}
                                  className="px-3 py-1.5 rounded-lg text-[10px] font-black border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                                >
                                  취소
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div
                              className="text-xs text-slate-700 leading-relaxed font-medium [&>strong]:font-bold [&>strong]:text-slate-900 max-h-52 overflow-y-auto cursor-zoom-in"
                              onDoubleClick={() => setPipelineSummaryModalBidId(row.bid_id)}
                              dangerouslySetInnerHTML={{ __html: renderSummaryHtml(row.summary) }}
                            />
                          )}
                        </div>
                        <div className="mt-4 rounded-2xl border border-blue-100 bg-blue-50/80 p-4">
                          <label className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5 block">
                            대표님 피드백
                          </label>
                          <textarea
                            placeholder="대표님의 의견, 전략 방향, 추가 지시사항 등을 기록해 두세요."
                            defaultValue={row.ceo_feedback ?? ''}
                            key={`ceo-feedback-${row.bid_id}-${String(row.ceo_feedback ?? '')}`}
                            onBlur={(e) =>
                              updatePipelineCeoFeedback(row.bid_id, e.target.value.trim())
                            }
                            className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm font-medium text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-400/30 focus:border-blue-300 resize-none min-h-[64px]"
                          />
                        </div>
                      </div>
                      <div className="flex flex-col sm:flex-row sm:items-end gap-4 px-6 py-5 bg-slate-50/85 border-t border-slate-100">
                        <div className="flex-1 min-w-0">
                          <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5 block">영업 메모</label>
                          <PipelineSalesMemoTextarea
                            bidId={row.bid_id}
                            memo={row.memo ?? ''}
                            onSave={(v) => updatePipelineMemo(row.bid_id, v)}
                            className="w-full bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-sm font-medium text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/25 focus:border-indigo-300 resize-none overflow-hidden min-h-[42px]"
                          />
                        </div>
                        <div className="flex justify-end sm:pb-0.5">
                          <button
                            type="button"
                            onClick={() => void togglePipelineEmailed(row.bid_id)}
                            className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-xs font-black border-2 transition-all ${
                              emailed
                                ? 'bg-emerald-500/15 border-emerald-400 text-emerald-900 shadow-sm'
                                : 'bg-white border-slate-200 text-slate-600 hover:border-indigo-300 hover:bg-indigo-50/60'
                            }`}
                          >
                            <Mail className="w-3.5 h-3.5 shrink-0" />
                            {emailed ? '메일 발송 완료' : '메일 미발송 · 클릭하여 변경'}
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
                  </ul>
                )}
              </div>

              {pipelineSummaryModalBidId &&
                (() => {
                  const modalRow = savedBidsData.find(
                    (r) => r.bid_id === pipelineSummaryModalBidId
                  );
                  if (!modalRow) return null;
                  return (
                    <div
                      className="fixed inset-0 z-50 flex items-center justify-center p-4"
                      aria-modal="true"
                      role="dialog"
                    >
                      <div
                        className="absolute inset-0 bg-black/50"
                        onClick={() => setPipelineSummaryModalBidId(null)}
                      />
                      <div className="relative bg-white rounded-3xl border border-slate-200 shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col">
                        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
                          <div>
                            <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">
                              AI 분석 요약 (확대 보기)
                            </p>
                            <p className="text-sm font-semibold text-slate-700 line-clamp-1">
                              {modalRow.title ?? '-'}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => setPipelineSummaryModalBidId(null)}
                            className="p-2 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                          >
                            <X className="w-5 h-5" />
                          </button>
                        </div>
                        <div
                          className="flex-1 overflow-y-auto p-6 text-base sm:text-lg leading-relaxed text-slate-800 font-medium [&>strong]:font-bold [&>strong]:text-slate-900"
                          dangerouslySetInnerHTML={{ __html: renderSummaryHtml(modalRow.summary) }}
                        />
                      </div>
                    </div>
                  );
                })()}
            </div>

            <div className="w-[350px] shrink-0 h-full overflow-y-auto bg-gray-50 p-5 rounded-xl border border-gray-200 sticky top-0 flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-black text-slate-800">💬 대표님 피드백</div>
                <button
                  type="button"
                  onClick={() => void markAllFeedbacksAsRead()}
                  className="text-[11px] font-bold text-slate-600 bg-white border border-slate-200 px-3 py-1.5 rounded-lg hover:bg-slate-50"
                >
                  모두 읽음 처리
                </button>
              </div>

              <div className="space-y-3">
                {savedBidsData.filter((b) => b.ceo_feedback && !b.is_feedback_read).length === 0 ? (
                  <div className="rounded-xl border border-slate-200 bg-white p-4 text-xs font-medium text-slate-400 text-center">
                    새로운 대표님 피드백이 없습니다.
                  </div>
                ) : (
                  savedBidsData
                    .filter((b) => b.ceo_feedback && !b.is_feedback_read)
                    .map((b) => (
                      <div
                        key={`fb-${b.bid_id}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          setSelectedPipelineBidId(b.bid_id);
                          const el = document.getElementById(`pipeline-${b.bid_id}`);
                          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }}
                        className="rounded-2xl border border-slate-200 bg-white p-3 hover:bg-slate-50 transition-colors"
                      >
                        <div className="text-xs font-bold text-slate-800 truncate">{b.title ?? '-'}</div>
                        <div className="text-[11px] text-slate-500 mt-1 line-clamp-2">
                          {String(b.ceo_feedback)}
                        </div>
                        <div className="mt-3 flex justify-end">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void markFeedbackAsRead(b.bid_id);
                            }}
                            className="text-[10px] font-bold px-2.5 py-1 rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                          >
                            ✅ 확인 완료
                          </button>
                        </div>
                      </div>
                    ))
                )}
              </div>
            </div>
          </div>
        </main>
      ) : (
        <main className="flex-1 p-8 overflow-auto bg-[#f1f5f9] flex justify-center items-start">
          <div className="max-w-4xl w-full flex flex-col gap-6 pb-20">
            <div className="flex items-center justify-between mb-2"><div><h2 className="text-2xl font-black text-slate-800 tracking-tight">시스템 환경설정</h2><p className="text-sm font-bold text-slate-400 mt-1">API Key, 검색 키워드, AI 프롬프트를 관리합니다.</p></div><button onClick={saveSettings} className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-xl text-sm font-black flex items-center gap-2 transition-all shadow-lg shadow-indigo-200"><Save className="w-4 h-4" /> 전체 저장</button></div>
            <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-8"><h3 className="text-base font-black text-slate-800 mb-2 flex items-center gap-2"><Key className="w-5 h-5 text-indigo-500" /> Gemini API 설정</h3><p className="text-xs text-slate-500 font-medium mb-5">과업지시서 문서를 요약하기 위해 발급받은 Google Gemini API Key를 입력하세요.</p><div className="relative"><input type="password" placeholder="AIzaSyA..." value={geminiApiKey} onChange={(e) => setGeminiApiKey(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-mono text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all" /></div></div>
            <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-8">
              <div className="flex items-center justify-between mb-5"><h3 className="text-base font-black text-slate-800 flex items-center gap-2"><Archive className="w-5 h-5 text-indigo-500" /> AI 프롬프트 아카이브</h3><button onClick={addNewPrompt} className="text-xs font-bold text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-lg hover:bg-indigo-100 transition-colors flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> 새 프롬프트</button></div>
              <p className="text-xs text-slate-500 font-medium mb-5">상황별로 여러 프롬프트를 저장해두고 교체할 수 있습니다.</p>
              <div className="flex gap-6">
                <div className="w-1/3 flex flex-col gap-2 border-r border-slate-100 pr-4">{prompts.map(p => (<button key={p.id} onClick={() => setActivePromptId(p.id)} className={`text-left p-3 rounded-xl border text-sm font-bold transition-all ${activePromptId === p.id ? 'bg-indigo-50 border-indigo-200 text-indigo-700 shadow-sm' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}><div className="flex justify-between items-center"><span className="truncate pr-2">{p.title}</span>{activePromptId === p.id && <CheckCircle2 className="w-4 h-4 text-indigo-500 flex-shrink-0" />}</div></button>))}</div>
                <div className="w-2/3 flex flex-col gap-3">
                  <div className="flex gap-2 items-center"><input type="text" value={prompts.find(p => p.id === activePromptId)?.title || ''} onChange={(e) => updateActivePrompt('title', e.target.value)} className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm font-bold text-slate-800 focus:outline-none focus:border-indigo-500" placeholder="프롬프트 제목" /><button onClick={() => deletePrompt(activePromptId)} className="p-2 text-slate-400 hover:text-red-500 bg-slate-50 rounded-lg border border-slate-200 hover:border-red-200 transition-colors"><X className="w-4 h-4" /></button></div>
                  <textarea value={editingPromptContent} onChange={(e) => { setEditingPromptContent(e.target.value); updateActivePrompt('content', e.target.value); }} className="w-full h-48 bg-slate-50 border border-slate-200 rounded-lg p-4 text-sm font-medium text-slate-700 leading-relaxed focus:outline-none focus:border-indigo-500 transition-all resize-none font-mono" />
                </div>
              </div>
            </div>
          </div>
        </main>
      )}

      <footer className="bg-white border-t border-slate-200 px-8 py-2.5 flex items-center justify-between text-[10px] font-bold text-slate-400 uppercase tracking-widest z-30">
        <div className="flex items-center gap-4"><div className="flex items-center gap-1.5 text-emerald-500"><div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></div>System Live</div><div className="flex items-center gap-1.5"><RefreshCcw className="w-3 h-3" />Last Sync: {footerTime || '—'}</div></div>
        <div>Wide Space Bid Intelligence &copy; 2026</div>
      </footer>
    </div>
  );
}
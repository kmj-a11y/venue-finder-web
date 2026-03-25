"use client";
import React, { useState, useEffect, useRef } from 'react';
import { 
  Search, RefreshCcw, MapPin, Users, Calendar, Mail, Phone, User, 
  ExternalLink, ChevronRight, Download, AlertCircle, Building2, Clock, 
  FileText, Trophy, Activity, Filter, Tag, Settings, Plus, X, Save, 
  Key, Archive, Bookmark, BookmarkCheck, CheckCircle2, List, Loader2
} from 'lucide-react';

/** 공고명에 공백/붙여쓰기 관계없이 '채용대행' 또는 '채용위탁' 용역만 표시 */
function isRecruitmentAgencyBidTitle(title: string | undefined | null): boolean {
  if (!title || typeof title !== 'string') return false;
  const compact = title.replace(/\s+/g, '');
  return compact.includes('채용대행') || compact.includes('채용위탁');
}

function hasRealSummary(bid) {
  const s = bid.summary;
  if (!s || s === '-' || String(s).trim() === '') return false;
  const text = String(s);
  if (text.includes('파일 읽기 에러') || text.includes('파일 읽기 실패')) return false;
  if (text.includes('첨부파일 본문을 읽을 수 없으므로')) return false;
  return true;
}

/** 게시일 문자열 기준 최신순 정렬 */
function compareBidsByNoticeDesc(a, b) {
  const da = String(a.noticeDate ?? '').replace(/\D/g, '');
  const db = String(b.noticeDate ?? '').replace(/\D/g, '');
  return db.localeCompare(da, undefined, { numeric: true });
}

/**
 * API로 받은 건은 최신 필드로 갱신하고, 이미 분석해 둔 summary 등은 유지.
 * API에 일시적으로 안 나오는 id도 기존 목록에서 사라지지 않음(증분 동기화).
 */
function mergeFetchedBidsWithPrevious(prev, freshWithCache) {
  const map = new Map((prev ?? []).map((b) => [b.id, b]));
  for (const b of freshWithCache) {
    const old = map.get(b.id);
    if (!old) {
      map.set(b.id, b);
      continue;
    }
    const keepSummary =
      old.summary &&
      old.summary !== '-' &&
      !String(old.summary).startsWith('⚠️') &&
      hasRealSummary(old);
    map.set(b.id, {
      ...b,
      summary: keepSummary ? old.summary : b.summary,
    });
  }
  return Array.from(map.values()).sort(compareBidsByNoticeDesc);
}

function formatKoreanCurrency(amount) {
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

function safeFormatDate(str) {
  if (str == null || str === '') return '-';
  const digits = String(str).replace(/\D/g, '');
  if (digits.length < 8) return '-';
  const y = digits.slice(0, 4);
  const m = digits.slice(4, 6);
  const d = digits.slice(6, 8);
  return `${y}-${m}-${d}`;
}

function renderSummaryHtml(text) {
  if (text == null || text === '') return '-';
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br/>');
}

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [isLoading, setIsLoading] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [loadingPhase, setLoadingPhase] = useState<'idle' | 'fetch'>('idle');
  const [toastMessage, setToastMessage] = useState('');

  const [selectedMonth, setSelectedMonth] = useState('2026-03');
  const [searchKeyword, setSearchKeyword] = useState('');
  const [showSavedOnly, setShowSavedOnly] = useState(false);
  const [selectedBid, setSelectedBid] = useState(null);
  const [bidResult, setBidResult] = useState(null);
  const [bids, setBids] = useState([]);
  const [savedBidIds, setSavedBidIds] = useState(new Set()); 
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [summaryModalOpen, setSummaryModalOpen] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [adminKeywords, setAdminKeywords] = useState(['외부대관', '면접장', '필기시험', 'NCS', '채용대행', '공간임차']);
  const [activeKeywords, setActiveKeywords] = useState(['외부대관', '면접장']);
  const [newKeywordInput, setNewKeywordInput] = useState('');
  
  const [prompts, setPrompts] = useState([
    {
      id: 1,
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
  const [activePromptId, setActivePromptId] = useState(1);
  const [editingPromptContent, setEditingPromptContent] = useState('');
  const [footerTime, setFooterTime] = useState(''); // 하이드레이션 방지: 마운트 후에만 시각 표시

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
          if (appSettings.keywords && Array.isArray(appSettings.keywords)) {
            setAdminKeywords(appSettings.keywords);
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
    handleRefresh(); 
  }, []);

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
        if (!cancelled && data.status != null) setBidResult({ status: data.status, winner: data.winner ?? '-', amount: data.amount ?? '-' });
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

  const handleRefresh = async () => {
    setIsLoading(true);
    setLoadingPhase('fetch');
    try {
      // 조달청 API는 공고명(bidNtceNm) 부분검색 — 기본 '채용'으로 넓게 받은 뒤, 아래 필터에서 채용대행·채용위탁만 표시
      const keyword = searchKeyword.trim() || '채용';
      const res = await fetch(`/api/g2b?month=${selectedMonth}&keyword=${encodeURIComponent(keyword)}`, {
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

        return {
          id: `${bidNtceNo}-${bidNtceOrd}`,
          bidNtceNo,
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
          result: { winner: '-', price: '-' },
          files,
          crawledAt: new Date().toISOString(),
        };
      };

      const rawBids = itemList.map(mapItem);
      const filteredBids = rawBids.filter((b) => isRecruitmentAgencyBidTitle(b.title));

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
      setBids((prev) => mergeFetchedBidsWithPrevious(prev, mergedBids));
      showToast(`동기화 완료: 이번에 반영된 채용대행·위탁 공고 ${mergedBids.length}건 (기존 목록과 병합)`);
    } catch (err) {
      console.error('handleRefresh error:', err);
      showToast('공고 데이터를 가져오는 데 실패했습니다. 기존 목록은 유지됩니다.');
    } finally {
      setIsLoading(false);
      setLoadingPhase('idle');
    }
  };

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
    const promptContent = prompts[0]?.content ?? '';
    if (!geminiKey || !promptContent.trim()) {
      showToast('설정에서 Gemini API Key와 프롬프트를 먼저 저장해 주세요.');
      return;
    }
    const formData = new FormData();
    formData.append('bid', JSON.stringify(selectedBid));
    formData.append('prompt', promptContent);
    formData.append('geminiKey', geminiKey);
    // 서버는 단일 'file' 필드를 기대하므로 첫 번째 파일만 전송
    formData.append('file', uploadFiles[0]);

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
      setUploadFiles([]);
      if (uploadInputRef.current) uploadInputRef.current.value = '';
      if (summaryEmpty) {
        showToast('파일에서 텍스트를 추출하지 못했거나 분석 결과가 비었습니다. PDF/hwpx/hwp 형식을 확인해 주세요.');
      } else {
        showToast('업로드한 첨부파일 기준으로 AI 재분석이 완료되었습니다.');
      }
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
    const newSavedIds = new Set(savedBidIds);
    if (newSavedIds.has(bid.id)) {
      newSavedIds.delete(bid.id);
      showToast('보관함에서 제거되었습니다.');
    } else {
      newSavedIds.add(bid.id);
      showToast('보관함에 저장되었습니다.');
    }
    setSavedBidIds(newSavedIds);
  };

  const saveSettings = async () => {
    try {
      const { error: appSettingsError } = await supabase
        .from('app_settings')
        .upsert({
          id: 1,
          gemini_api_key: geminiApiKey,
          keywords: adminKeywords,
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
    const newId = Date.now();
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

  const toggleKeywordFilter = (kw) => setActiveKeywords(prev => prev.includes(kw) ? prev.filter(k => k !== kw) : [...prev, kw]);

  const handleAddAdminKeyword = (e) => {
    if (e.key === 'Enter' || e.type === 'click') {
      const kw = newKeywordInput.trim();
      if (kw && !adminKeywords.includes(kw)) {
        setAdminKeywords([...adminKeywords, kw]);
        setNewKeywordInput('');
      }
    }
  };

  const handleRemoveAdminKeyword = (kwToRemove) => {
    setAdminKeywords(adminKeywords.filter(kw => kw !== kwToRemove));
    setActiveKeywords(activeKeywords.filter(kw => kw !== kwToRemove));
  };

  const filteredBids = bids.filter(bid => {
    if (showSavedOnly && !savedBidIds.has(bid.id)) return false;
    if (searchKeyword && !bid.title.includes(searchKeyword) && !bid.org.includes(searchKeyword)) return false;
    return true;
  });

  const getStatusBadge = (status) => {
    const styles = {
      '입찰서 접수중': 'bg-blue-50 text-blue-600 border-blue-100',
      '입찰 마감': 'bg-slate-100 text-slate-600 border-slate-200',
      '개찰완료': 'bg-emerald-50 text-emerald-600 border-emerald-100',
      '유찰': 'bg-red-50 text-red-600 border-red-100',
    };
    return <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${styles[status] || 'bg-gray-50 text-gray-600'}`}>{status}</span>;
  };

  return (
    <div className="min-h-screen bg-[#f1f5f9] flex flex-col font-sans text-slate-900 relative">
      {toastMessage && (
        <div className="fixed bottom-6 right-6 bg-slate-900 text-white px-6 py-3 rounded-xl shadow-2xl flex items-center gap-3 z-50 animate-fade-in-up">
          <CheckCircle2 className="w-5 h-5 text-emerald-400" />
          <span className="text-sm font-bold">{toastMessage}</span>
        </div>
      )}

      <header className="bg-white border-b border-slate-200 px-8 py-4 flex items-center justify-between sticky top-0 z-30 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="bg-indigo-600 p-2 rounded-xl shadow-lg shadow-indigo-200"><Activity className="text-white w-5 h-5" /></div>
          <div><h1 className="text-lg font-black tracking-tight text-slate-800 uppercase">Venue Finder</h1><p className="text-[10px] text-slate-400 font-bold tracking-[0.2em]">SEOUL RECRUITMENT RADAR</p></div>
        </div>
        
        <div className="absolute left-1/2 -translate-x-1/2 flex items-center bg-slate-100 p-1 rounded-xl border border-slate-200">
          <button onClick={() => setActiveTab('dashboard')} className={`flex items-center gap-2 px-6 py-2 rounded-lg text-xs font-bold transition-all ${activeTab === 'dashboard' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}><Activity className="w-3.5 h-3.5" /> 대시보드</button>
          <button onClick={() => setActiveTab('settings')} className={`flex items-center gap-2 px-6 py-2 rounded-lg text-xs font-bold transition-all ${activeTab === 'settings' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}><Settings className="w-3.5 h-3.5" /> 시스템 설정</button>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center bg-slate-100 rounded-lg px-3 py-1.5 border border-slate-200 w-64 focus-within:ring-2 focus-within:ring-indigo-500 transition-all"><Search className="w-3.5 h-3.5 text-slate-400 mr-2" /><input type="text" placeholder="검색어 입력 (예: 예금보험)" value={searchKeyword} onChange={(e) => setSearchKeyword(e.target.value)} className="bg-transparent border-none focus:outline-none text-xs font-bold text-slate-700 w-full placeholder-slate-400" /></div>
          <div className="w-px h-5 bg-slate-200 mx-1"></div>
          <div className="flex items-center bg-slate-100 rounded-lg px-3 py-1.5 border border-slate-200"><Calendar className="w-3.5 h-3.5 text-slate-500 mr-2" /><input type="month" value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)} className="bg-transparent border-none focus:outline-none text-xs font-bold text-slate-700 w-32" /></div>
          <button onClick={handleRefresh} disabled={isLoading} className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white px-4 py-2 rounded-lg text-xs font-bold transition-all disabled:opacity-70 disabled:cursor-not-allowed"><RefreshCcw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} /> API 최신화</button>
          <button onClick={handleBatchAnalyze} disabled={isAnalyzing || isLoading} className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-xs font-bold transition-all disabled:opacity-70 disabled:cursor-not-allowed">{isAnalyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '✨'} 미분석 공고 AI 분석</button>
        </div>
      </header>

      {activeTab === 'dashboard' ? (
        <>
          <div className="bg-slate-50 border-b border-slate-200 px-8 py-2.5 flex items-center justify-between relative z-20">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 text-[10px] font-black text-slate-500 uppercase tracking-widest mr-2"><Filter className="w-3 h-3 text-indigo-500" /> AI 필터 키워드</div>
              <div className="flex flex-wrap gap-2">
                {adminKeywords.map((kw) => (
                  <button key={kw} onClick={() => toggleKeywordFilter(kw)} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold border transition-all ${activeKeywords.includes(kw) ? 'bg-indigo-100 text-indigo-700 border-indigo-200 shadow-sm' : 'bg-white text-slate-500 border-slate-200'}`}><Tag className={`w-2.5 h-2.5 ${activeKeywords.includes(kw) ? 'text-indigo-500' : 'text-slate-400'}`} /> {kw}</button>
                ))}
              </div>
            </div>
            
            <div className="flex bg-slate-200 p-0.5 rounded-lg border border-slate-300">
              <button onClick={() => setShowSavedOnly(false)} className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] font-bold transition-all ${!showSavedOnly ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}><List className="w-3 h-3" /> 전체 공고</button>
              <button onClick={() => setShowSavedOnly(true)} className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] font-bold transition-all ${showSavedOnly ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}><Bookmark className="w-3 h-3" /> 보관함 ({savedBidIds.size})</button>
            </div>
          </div>

          {isLoading && (
            <div className="mx-8 mt-4 flex items-center justify-center gap-3 rounded-xl bg-indigo-50 border border-indigo-100 px-6 py-4">
              <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin text-indigo-600" />
              <span className="text-sm font-bold text-indigo-800">데이터 수집 중...</span>
            </div>
          )}

          <main className="flex-1 p-6 overflow-hidden flex gap-6">
            <div className="flex-1 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
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
                      return (
                        <tr key={bid.id} onClick={() => setSelectedBid(bid)} className={`group cursor-pointer transition-colors ${selectedBid?.id === bid.id ? 'bg-indigo-50/50' : hasRealSummary(bid) ? 'bg-yellow-50' : 'bg-white'} hover:opacity-90`}>
                          <td className="px-5 py-4 w-10"><button onClick={(e) => toggleSaveBid(e, bid)} className="text-slate-300 hover:text-indigo-500 transition-colors">{isSaved ? <BookmarkCheck className="w-5 h-5 text-indigo-600 fill-indigo-100" /> : <Bookmark className="w-5 h-5" />}</button></td>
                          <td className="px-5 py-4"><div className="font-bold text-slate-800 text-sm group-hover:text-indigo-600 transition-colors line-clamp-1">{bid.title}</div><div className="flex items-center text-[11px] text-slate-400 font-bold mt-1"><Building2 className="w-3 h-3 mr-1 text-slate-300" /> {bid.org}</div></td>
                          <td className="px-5 py-4 text-center"><div className="flex flex-col items-center gap-1.5"><div className="text-[10px] font-bold text-slate-400">게시일: {bid.noticeDate ?? '-'}</div><div className="flex items-center text-[11px] font-bold text-slate-600"><Calendar className="w-3 h-3 mr-1 text-slate-400" />{bid.deadline}</div>{getStatusBadge(bid.status)}</div></td>
                          <td className="px-5 py-4 text-right"><div className="text-sm font-black text-slate-800">{bid.budget}</div><div className="text-[10px] text-slate-400 font-bold mt-1 flex items-center justify-end"><Users className="w-3 h-3 mr-1" /> {bid.scale}</div></td>
                        </tr>
                      );
                    })}
                    {filteredBids.length === 0 && (<tr><td colSpan="4" className="text-center py-12 text-slate-400 text-sm font-bold">표시할 공고가 없습니다.</td></tr>)}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="w-[450px] flex flex-col gap-5 overflow-auto pr-1">
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
                        <span className="text-[10px] text-slate-400 font-medium">클릭 시 전체 보기</span>
                      </div>
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => setSummaryModalOpen(true)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSummaryModalOpen(true); } }}
                        className="w-full text-left text-xs text-slate-600 leading-relaxed font-medium bg-indigo-50/30 p-4 rounded-xl border border-indigo-100/30 break-words [&>strong]:font-bold [&>strong]:text-slate-800 max-h-80 overflow-y-auto cursor-pointer hover:bg-indigo-50/50 hover:border-indigo-200/50 transition-colors"
                      >
                        <div dangerouslySetInnerHTML={{ __html: renderSummaryHtml(selectedBid.summary) }} />
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
          </main>
        </>
      ) : (
        <main className="flex-1 p-8 overflow-auto bg-[#f1f5f9] flex justify-center items-start">
          <div className="max-w-4xl w-full flex flex-col gap-6 pb-20">
            <div className="flex items-center justify-between mb-2"><div><h2 className="text-2xl font-black text-slate-800 tracking-tight">시스템 환경설정</h2><p className="text-sm font-bold text-slate-400 mt-1">API Key, 검색 키워드, AI 프롬프트를 관리합니다.</p></div><button onClick={saveSettings} className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-xl text-sm font-black flex items-center gap-2 transition-all shadow-lg shadow-indigo-200"><Save className="w-4 h-4" /> 전체 저장</button></div>
            <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-8"><h3 className="text-base font-black text-slate-800 mb-2 flex items-center gap-2"><Key className="w-5 h-5 text-indigo-500" /> Gemini API 설정</h3><p className="text-xs text-slate-500 font-medium mb-5">과업지시서 문서를 요약하기 위해 발급받은 Google Gemini API Key를 입력하세요.</p><div className="relative"><input type="password" placeholder="AIzaSyA..." value={geminiApiKey} onChange={(e) => setGeminiApiKey(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm font-mono text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all" /></div></div>
            <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-8"><h3 className="text-base font-black text-slate-800 mb-2 flex items-center gap-2"><Tag className="w-5 h-5 text-indigo-500" /> 타겟 키워드 관리</h3><p className="text-xs text-slate-500 font-medium mb-5">대시보드 상단에 표시되며, 공고 필터링 시 기준으로 삼을 핵심 단어입니다.</p><div className="flex gap-2 mb-4"><input type="text" placeholder="새로운 키워드 입력" value={newKeywordInput} onChange={(e) => setNewKeywordInput(e.target.value)} onKeyDown={handleAddAdminKeyword} className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all" /><button onClick={handleAddAdminKeyword} className="bg-slate-900 hover:bg-slate-800 text-white px-5 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 transition-all"><Plus className="w-4 h-4" /> 추가</button></div><div className="flex flex-wrap gap-2 p-5 bg-slate-50 rounded-2xl border border-slate-100 min-h-[80px]">{adminKeywords.map((kw) => (<div key={kw} className="flex items-center gap-2 bg-white border border-slate-200 px-3 py-1.5 rounded-lg shadow-sm group"><span className="text-xs font-bold text-slate-700">{kw}</span><button onClick={() => handleRemoveAdminKeyword(kw)} className="text-slate-300 hover:text-red-500 transition-colors"><X className="w-3.5 h-3.5" /></button></div>))}</div></div>
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
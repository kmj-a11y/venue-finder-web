"""
venue-finder-converter: HWP → PDF 로컬 변환 서버

웹 앱(venue-finder-web)의 '일괄 PDF 변환' 버튼이 이 서버로 요청을 보내면,
지정된 폴더 안의 모든 HWP 파일을 재귀적으로 찾아 한컴오피스로 PDF 변환한다.

구성:
- Flask 서버 (127.0.0.1:5555) — 백그라운드 스레드
- 시스템 트레이 아이콘 (pystray) — 메인 스레드
- HWP → PDF 변환 — pywin32로 한컴오피스 COM 자동화
"""

import logging
import os
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import List, Dict, Any

import pythoncom
import win32com.client
from flask import Flask, jsonify, request
from flask_cors import CORS
from PIL import Image, ImageDraw
import pystray

# ─────────────────────────────────────────────
# 설정
# ─────────────────────────────────────────────
PORT = 5555
HOST = "127.0.0.1"
VERSION = "1.1.0"

# venue-finder-web이 배포된 Vercel 도메인(들). 로컬 개발용 포트도 포함.
# Vercel 미리보기 주소(venue-finder-web-xxxx.vercel.app)까지 받도록 정규식으로 허용.
ALLOWED_ORIGINS = [
    re.compile(r"^https://venue-finder[a-z0-9-]*\.vercel\.app$"),
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]

# 웹 설정에 저장 폴더를 비워두면 쓰는 기본 위치
DEFAULT_DOWNLOAD_DIR = Path.home() / "Downloads" / "나라장터공고"

LOG_DIR = Path(os.environ.get("APPDATA", str(Path.home()))) / "venue-finder-converter"
LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_FILE = LOG_DIR / "converter.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("converter")


# ─────────────────────────────────────────────
# HWP → PDF 변환 핵심
# ─────────────────────────────────────────────
def _register_hwp_security_module(hwp) -> None:
    """
    한컴오피스는 외부 자동화 호출 시 '파일 접근 허용' 보안 창을 띄운다.
    한컴 공식 보안모듈(FilePathCheckerModuleExample.dll)을 등록하면 그 창이 생략된다.
    - DLL 경로는 register_security.ps1이 레지스트리에 미리 등록해 둔다
      (HKCU\\Software\\HNC\\HwpAutomation\\Modules\\FilePathCheckerModuleExample)
    - 첫 인자는 고정값 "FilePathCheckDLL", 두 번째 인자는 위 레지스트리 값 이름과 같아야 한다
    """
    try:
        ok = hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModuleExample")
        if ok:
            log.info("보안모듈 등록 성공 (접근 허용 창 생략)")
        else:
            log.warning("보안모듈 등록 실패: install.bat을 다시 실행해 레지스트리 등록을 확인하세요")
    except Exception as e:
        # 보안 모듈 등록 실패해도 변환은 가능 (접근 허용 창이 뜰 수 있음)
        log.warning(f"RegisterModule 예외(계속 진행): {e}")


def _save_as_pdf(hwp_app, pdf_path: Path) -> None:
    """
    현재 열린 문서를 PDF로 저장한다. 한컴 버전마다 SaveAs 인자 규격이 달라
    두 가지 방법을 차례로 시도한다.
    1) SaveAs(경로, "PDF", "") — 인자 3개를 모두 넘기는 방식
    2) HAction "FileSaveAsPdf" — 한컴 내부 'PDF로 저장' 메뉴 액션
    """
    target = str(pdf_path.absolute())

    try:
        hwp_app.SaveAs(target, "PDF", "")
        if pdf_path.exists():
            return
        log.warning("SaveAs 호출 후 PDF가 없음 → HAction 방식으로 재시도")
    except Exception as e:
        log.warning(f"SaveAs 방식 실패({e}) → HAction 방식으로 재시도")

    pset = hwp_app.HParameterSet.HFileOpenSave
    hwp_app.HAction.GetDefault("FileSaveAsPdf", pset.HSet)
    pset.filename = target
    pset.Format = "PDF"
    pset.Attributes = 16384
    hwp_app.HAction.Execute("FileSaveAsPdf", pset.HSet)


def convert_single_hwp(hwp_app, hwp_path: Path, delete_original: bool) -> Dict[str, Any]:
    """
    HWP 1개를 PDF로 변환. 기존 Hwp COM 객체(hwp_app)를 재사용한다.
    """
    pdf_path = hwp_path.with_suffix(".pdf")

    # 이미 PDF가 있으면 스킵 (덮어쓰기 방지)
    if pdf_path.exists():
        log.info(f"스킵 (PDF 존재): {hwp_path.name}")
        return {"file": str(hwp_path), "status": "skipped", "reason": "PDF already exists"}

    step = "open"
    try:
        hwp_app.Open(str(hwp_path.absolute()), "", "forceopen:true")

        step = "save_pdf"
        _save_as_pdf(hwp_app, pdf_path)

        if not pdf_path.exists():
            raise RuntimeError("PDF 저장 호출은 끝났지만 파일이 생성되지 않았습니다")

        step = "close"
        hwp_app.Clear(1)  # 현재 문서 닫기 (저장 안 함)

        if delete_original:
            try:
                hwp_path.unlink()
            except Exception as e:
                log.warning(f"원본 HWP 삭제 실패 {hwp_path.name}: {e}")

        log.info(f"변환 성공: {hwp_path.name} → {pdf_path.name}")
        return {"file": str(hwp_path), "status": "success", "pdf": str(pdf_path)}

    except Exception as e:
        log.error(f"변환 실패 [{step}] {hwp_path.name}: {e}")
        try:
            hwp_app.Clear(1)
        except Exception:
            pass
        return {"file": str(hwp_path), "status": "failed", "step": step, "error": str(e)}


HWP_SUFFIXES = {".hwp", ".hwpx"}

# 한글 COM은 동시에 두 작업을 돌리면 꼬이므로 변환은 한 번에 하나씩만 실행한다.
_convert_lock = threading.Lock()


def find_hwp_files(folder: Path) -> List[Path]:
    """폴더(하위 포함) 안의 HWP/HWPX 파일 목록 (대소문자 무관, 중복 제거)."""
    found = [p for p in folder.rglob("*") if p.is_file() and p.suffix.lower() in HWP_SUFFIXES]
    return list({p.absolute(): p for p in found}.values())


def convert_folder(folder: Path, delete_original: bool = True) -> Dict[str, Any]:
    """
    지정 폴더(및 하위 폴더) 안의 모든 HWP/HWPX 파일을 PDF로 변환.
    """
    if not folder.exists() or not folder.is_dir():
        return {"ok": False, "error": f"폴더가 존재하지 않습니다: {folder}"}
    return convert_files(find_hwp_files(folder), delete_original=delete_original)


def convert_files(hwp_files: List[Path], delete_original: bool = True) -> Dict[str, Any]:
    """
    주어진 HWP/HWPX 파일들을 한글을 한 번만 띄워 차례로 PDF 변환한다.
    """
    if not hwp_files:
        return {
            "ok": True,
            "total": 0,
            "success": 0,
            "failed": 0,
            "skipped": 0,
            "results": [],
            "message": "변환할 HWP/HWPX 파일이 없습니다",
        }

    with _convert_lock:
        return _convert_files_locked(hwp_files, delete_original)


def _convert_files_locked(hwp_files: List[Path], delete_original: bool) -> Dict[str, Any]:
    log.info(f"변환 시작: HWP/HWPX {len(hwp_files)}개")

    # COM 객체 초기화 (스레드별)
    pythoncom.CoInitialize()
    hwp_app = None
    try:
        hwp_app = win32com.client.Dispatch("HWPFrame.HwpObject")
        _register_hwp_security_module(hwp_app)
        # 창 숨김 (SetVisible은 일부 버전에서 오류 — 안전하게 try)
        try:
            hwp_app.XHwpWindows.Item(0).Visible = False
        except Exception:
            pass

        results = []
        for hwp_path in hwp_files:
            result = convert_single_hwp(hwp_app, hwp_path, delete_original)
            results.append(result)

        success = sum(1 for r in results if r["status"] == "success")
        failed = sum(1 for r in results if r["status"] == "failed")
        skipped = sum(1 for r in results if r["status"] == "skipped")

        log.info(f"변환 완료: 성공 {success}, 실패 {failed}, 스킵 {skipped}")

        return {
            "ok": True,
            "total": len(hwp_files),
            "success": success,
            "failed": failed,
            "skipped": skipped,
            "results": results,
        }

    except Exception as e:
        log.exception("한컴오피스 COM 초기화/변환 중 예외")
        return {"ok": False, "error": f"한컴오피스 자동화 실패: {e}"}

    finally:
        try:
            if hwp_app is not None:
                hwp_app.Quit()
        except Exception:
            pass
        pythoncom.CoUninitialize()


# ─────────────────────────────────────────────
# 조달청 첨부파일 다운로드
# ─────────────────────────────────────────────
DOWNLOAD_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
_INVALID_NAME_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def safe_name(name: str, max_len: int) -> str:
    """Windows 파일/폴더명으로 쓸 수 없는 문자를 바꾸고 길이를 제한한다."""
    cleaned = _INVALID_NAME_CHARS.sub("_", str(name or "")).strip()
    cleaned = re.sub(r"\s+", " ", cleaned).rstrip(". ")
    if len(cleaned) > max_len:
        cleaned = cleaned[:max_len].rstrip(". ")
    return cleaned or "이름없음"


def safe_file_name(name: str, max_len: int = 120) -> str:
    """확장자는 지키면서 파일명 길이를 제한한다."""
    p = Path(safe_name(name, 1000))
    stem, suffix = p.stem, p.suffix[:10]
    return safe_name(stem, max_len - len(suffix)) + suffix


def is_allowed_download_url(url: str) -> bool:
    """조달청(g2b.go.kr) 주소만 허용한다."""
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception:
        return False
    host = (parsed.hostname or "").lower()
    return parsed.scheme in ("http", "https") and (host == "g2b.go.kr" or host.endswith(".g2b.go.kr"))


def download_file(url: str, dest: Path) -> None:
    """URL을 dest로 내려받는다. 중간에 실패하면 반쯤 받은 파일은 지운다."""
    req = urllib.request.Request(url, headers={
        "User-Agent": DOWNLOAD_USER_AGENT,
        "Referer": "https://www.g2b.go.kr/",
    })
    tmp = dest.with_name(dest.name + ".part")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, "wb") as out:
            while True:
                chunk = resp.read(1024 * 256)
                if not chunk:
                    break
                out.write(chunk)
        if tmp.stat().st_size == 0:
            raise RuntimeError("빈 파일이 내려왔습니다")
        tmp.replace(dest)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except Exception:
                pass


def download_bid_files(base: Path, bid: Dict[str, Any]) -> Dict[str, Any]:
    """공고 1건의 첨부를 base/기관명/공고명/ 아래로 내려받는다."""
    org = safe_name(bid.get("org") or "기관미상", 40)
    title = safe_name(bid.get("title") or bid.get("id") or "공고명미상", 80)
    folder = base / org / title
    folder.mkdir(parents=True, exist_ok=True)

    results: List[Dict[str, Any]] = []
    seen_urls = set()
    used_names = set()

    for f in bid.get("files") or []:
        url = str((f or {}).get("url") or "").strip()
        raw_name = str((f or {}).get("name") or "").strip() or "첨부파일"
        if not url or url in seen_urls:
            continue
        seen_urls.add(url)

        if not is_allowed_download_url(url):
            results.append({"name": raw_name, "status": "failed", "error": "조달청 주소가 아님"})
            continue

        name = safe_file_name(raw_name)
        stem, suffix = Path(name).stem, Path(name).suffix
        n = 2
        while name.lower() in used_names:
            name = f"{stem} ({n}){suffix}"
            n += 1
        used_names.add(name.lower())

        dest = folder / name
        pdf_twin = dest.with_suffix(".pdf")
        if dest.exists() or (dest.suffix.lower() in HWP_SUFFIXES and pdf_twin.exists()):
            results.append({"name": name, "status": "skipped", "path": str(dest)})
            continue

        try:
            download_file(url, dest)
            log.info(f"다운로드 성공: {org}/{title}/{name}")
            results.append({"name": name, "status": "success", "path": str(dest)})
        except Exception as e:
            log.error(f"다운로드 실패 {org}/{title}/{name}: {e}")
            results.append({"name": name, "status": "failed", "error": str(e)})

    return {"id": bid.get("id"), "org": org, "title": title, "folder": str(folder), "files": results}


# ─────────────────────────────────────────────
# Flask 서버
# ─────────────────────────────────────────────
app = Flask(__name__)
CORS(app, origins=ALLOWED_ORIGINS)


@app.after_request
def allow_private_network(resp):
    """
    크롬은 인터넷 사이트(https)가 내 PC(127.0.0.1)로 요청할 때
    'Private Network Access' 사전 확인을 한다. 허용 응답 헤더를 붙여준다.
    """
    if request.headers.get("Access-Control-Request-Private-Network") == "true":
        resp.headers["Access-Control-Allow-Private-Network"] = "true"
    return resp


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "version": VERSION,
        "service": "venue-finder-converter",
        "defaultFolder": str(DEFAULT_DOWNLOAD_DIR),
    })


@app.route("/convert", methods=["POST", "OPTIONS"])
def convert():
    if request.method == "OPTIONS":
        return "", 204

    data = request.get_json(silent=True) or {}
    folder_str = data.get("folder", "").strip()
    delete_original = bool(data.get("deleteOriginal", True))

    if not folder_str:
        return jsonify({"ok": False, "error": "folder 파라미터가 필요합니다"}), 400

    folder = Path(folder_str).expanduser().resolve()
    log.info(f"변환 요청 수신: {folder} (원본삭제={delete_original})")

    result = convert_folder(folder, delete_original=delete_original)
    status = 200 if result.get("ok") else 500
    return jsonify(result), status


@app.route("/download", methods=["POST", "OPTIONS"])
def download():
    """
    웹 앱에서 체크한 공고들의 첨부를 받아 기관명/공고명 폴더로 분류하고,
    HWP/HWPX는 PDF로 변환한다.

    요청: {
      "baseFolder": "C:\\Users\\...\\나라장터공고",   (비우면 기본 폴더)
      "convert": true, "deleteOriginal": true, "openFolder": true,
      "bids": [{"id": "...", "org": "...", "title": "...", "files": [{"name": "...", "url": "..."}]}]
    }
    """
    if request.method == "OPTIONS":
        return "", 204

    data = request.get_json(silent=True) or {}
    bids = data.get("bids") or []
    if not isinstance(bids, list) or not bids:
        return jsonify({"ok": False, "error": "다운로드할 공고가 없습니다"}), 400

    base_str = str(data.get("baseFolder") or "").strip()
    base = Path(base_str).expanduser() if base_str else DEFAULT_DOWNLOAD_DIR
    if not base.is_absolute():
        return jsonify({"ok": False, "error": f"저장 폴더는 전체 경로로 적어주세요: {base_str}"}), 400
    try:
        base.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        return jsonify({"ok": False, "error": f"저장 폴더를 만들 수 없습니다: {base} ({e})"}), 400

    do_convert = bool(data.get("convert", True))
    delete_original = bool(data.get("deleteOriginal", True))
    log.info(f"다운로드 요청: 공고 {len(bids)}건 → {base} (변환={do_convert}, 원본삭제={delete_original})")

    bid_results = [download_bid_files(base, b) for b in bids if isinstance(b, dict)]

    conversion = None
    if do_convert:
        targets: List[Path] = []
        for br in bid_results:
            for f in br["files"]:
                p = Path(f.get("path") or "")
                if f["status"] in ("success", "skipped") and p.suffix.lower() in HWP_SUFFIXES and p.exists():
                    targets.append(p)
        conversion = convert_files(targets, delete_original=delete_original)

    downloaded = sum(1 for br in bid_results for f in br["files"] if f["status"] == "success")
    skipped = sum(1 for br in bid_results for f in br["files"] if f["status"] == "skipped")
    failed = sum(1 for br in bid_results for f in br["files"] if f["status"] == "failed")

    if data.get("openFolder", True):
        try:
            os.startfile(str(base))
        except Exception as e:
            log.warning(f"폴더 열기 실패: {e}")

    return jsonify({
        "ok": True,
        "baseFolder": str(base),
        "bids": bid_results,
        "downloaded": downloaded,
        "skipped": skipped,
        "failed": failed,
        "conversion": conversion,
    })


def run_flask():
    """Flask 서버를 별도 스레드에서 실행."""
    log.info(f"Flask 서버 시작: http://{HOST}:{PORT}")
    # debug=False로 production 모드. use_reloader=False는 트레이와 충돌 방지.
    app.run(host=HOST, port=PORT, debug=False, use_reloader=False, threaded=True)


# ─────────────────────────────────────────────
# 시스템 트레이 아이콘
# ─────────────────────────────────────────────
def make_icon_image() -> Image.Image:
    """트레이 아이콘용 이미지를 코드로 생성 (외부 파일 불필요)."""
    img = Image.new("RGB", (64, 64), color=(37, 99, 235))  # 파란 바탕
    draw = ImageDraw.Draw(img)
    # 중앙에 "V" 글자 (단순한 모양으로 아이덴티티)
    draw.polygon([(16, 14), (24, 14), (32, 42), (40, 14), (48, 14), (36, 50), (28, 50)],
                 fill=(255, 255, 255))
    return img


def on_open_log(icon, item):
    """트레이 메뉴: 로그 파일 열기."""
    try:
        os.startfile(str(LOG_FILE))
    except Exception as e:
        log.error(f"로그 파일 열기 실패: {e}")


def on_open_log_folder(icon, item):
    """트레이 메뉴: 로그 폴더 열기."""
    try:
        os.startfile(str(LOG_DIR))
    except Exception as e:
        log.error(f"로그 폴더 열기 실패: {e}")


def on_quit(icon, item):
    """트레이 메뉴: 종료."""
    log.info("사용자 요청으로 종료")
    icon.stop()
    # Flask는 데몬 스레드라 메인 종료 시 함께 종료됨
    os._exit(0)


def run_tray():
    """시스템 트레이 아이콘을 메인 스레드에서 실행 (블로킹)."""
    menu = pystray.Menu(
        pystray.MenuItem(f"venue-finder-converter v{VERSION}", None, enabled=False),
        pystray.MenuItem(f"포트: {PORT}", None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("로그 보기", on_open_log),
        pystray.MenuItem("로그 폴더 열기", on_open_log_folder),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("종료", on_quit),
    )
    icon = pystray.Icon(
        name="venue-finder-converter",
        icon=make_icon_image(),
        title=f"venue-finder 변환기 (포트 {PORT})",
        menu=menu,
    )
    icon.run()


# ─────────────────────────────────────────────
# 진입점
# ─────────────────────────────────────────────
def main():
    log.info("=" * 60)
    log.info(f"venue-finder-converter v{VERSION} 시작")
    log.info(f"로그 파일: {LOG_FILE}")
    log.info("=" * 60)

    # Flask는 백그라운드 데몬 스레드
    flask_thread = threading.Thread(target=run_flask, daemon=True)
    flask_thread.start()

    # 서버 뜨는 거 잠깐 대기
    time.sleep(1.0)

    # 트레이는 메인 스레드 (블로킹)
    run_tray()


if __name__ == "__main__":
    main()

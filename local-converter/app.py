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
import sys
import threading
import time
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
VERSION = "1.0.0"

# venue-finder-web이 배포된 Vercel 도메인(들). 로컬 개발용 포트도 포함.
ALLOWED_ORIGINS = [
    "https://venue-finder-web.vercel.app",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]

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
    한컴오피스는 외부 자동화 호출 시 보안 경고 창을 띄운다.
    FilePathCheckerModule을 등록하면 그 창을 생략할 수 있다.
    (한컴오피스 설치 시 함께 제공되는 모듈 — 별도 설치 불필요)
    """
    try:
        hwp.RegisterModule("FilePathCheckerModuleExample", "FilePathCheckerModule")
    except Exception as e:
        # 보안 모듈 등록 실패해도 변환은 가능 (경고창이 뜰 수 있음)
        log.warning(f"RegisterModule 실패(계속 진행): {e}")


def convert_single_hwp(hwp_app, hwp_path: Path, delete_original: bool) -> Dict[str, Any]:
    """
    HWP 1개를 PDF로 변환. 기존 Hwp COM 객체(hwp_app)를 재사용한다.
    """
    pdf_path = hwp_path.with_suffix(".pdf")

    # 이미 PDF가 있으면 스킵 (덮어쓰기 방지)
    if pdf_path.exists():
        log.info(f"스킵 (PDF 존재): {hwp_path.name}")
        return {"file": str(hwp_path), "status": "skipped", "reason": "PDF already exists"}

    try:
        hwp_app.Open(str(hwp_path.absolute()), "", "forceopen:true")
        # SaveAs: 두 번째 인자는 저장 포맷. "PDF"는 HWP 2010+에서 지원.
        hwp_app.SaveAs(str(pdf_path.absolute()), "PDF")
        hwp_app.Clear(1)  # 현재 문서 닫기 (저장 안 함)

        if delete_original:
            try:
                hwp_path.unlink()
            except Exception as e:
                log.warning(f"원본 HWP 삭제 실패 {hwp_path.name}: {e}")

        log.info(f"변환 성공: {hwp_path.name} → {pdf_path.name}")
        return {"file": str(hwp_path), "status": "success", "pdf": str(pdf_path)}

    except Exception as e:
        log.error(f"변환 실패 {hwp_path.name}: {e}")
        try:
            hwp_app.Clear(1)
        except Exception:
            pass
        return {"file": str(hwp_path), "status": "failed", "error": str(e)}


def convert_folder(folder: Path, delete_original: bool = True) -> Dict[str, Any]:
    """
    지정 폴더(및 하위 폴더) 안의 모든 .hwp 파일을 PDF로 변환.
    """
    if not folder.exists() or not folder.is_dir():
        return {"ok": False, "error": f"폴더가 존재하지 않습니다: {folder}"}

    # 재귀적으로 모든 HWP 찾기 (.hwp, .HWP 모두)
    hwp_files = list(folder.rglob("*.hwp")) + list(folder.rglob("*.HWP"))
    # 중복 제거 (대소문자 다른 같은 파일)
    hwp_files = list({f.absolute(): f for f in hwp_files}.values())

    if not hwp_files:
        return {
            "ok": True,
            "total": 0,
            "success": 0,
            "failed": 0,
            "skipped": 0,
            "results": [],
            "message": "변환할 HWP 파일이 없습니다",
        }

    log.info(f"변환 시작: {folder} 아래 HWP {len(hwp_files)}개")

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
# Flask 서버
# ─────────────────────────────────────────────
app = Flask(__name__)
CORS(app, origins=ALLOWED_ORIGINS)


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "version": VERSION,
        "service": "venue-finder-converter",
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

# venue-finder-converter

venue-finder-web 앱이 다운로드한 HWP 파일을 로컬 PC의 한컴오피스로 PDF 변환하는 트레이 서버.

## 어떻게 동작하는가

```
[venue-finder-web (브라우저)]
    │ 공고 다운로드 → 지정 폴더에 HWP+PDF 저장
    │ "일괄 PDF 변환" 버튼 클릭
    ↓
[HTTP POST → http://127.0.0.1:5555/convert]
    ↓
[이 트레이 앱 (venue-finder-converter)]
    ↓
[한컴오피스 COM 자동화]
    ├─ 폴더 내 모든 HWP를 재귀적으로 찾음
    ├─ 각 HWP를 열어 PDF로 저장
    └─ 원본 HWP 삭제 (옵션)
```

CloudConvert를 쓰지 않으므로 **무료·무제한·품질 100%**.

## 사전 요구사항

- Windows 10/11
- **한컴오피스 설치** (한글 2010 이상 권장)
- **Python 3.10 이상** 설치 — https://www.python.org/downloads/
  - 설치 시 **"Add Python to PATH"** 체크 필수

## 설치

1. 이 폴더(`local-converter`) 안에서 **`install.bat` 더블클릭**
2. 자동으로 수행되는 것
   - Python 의존성 설치 (`flask`, `pywin32`, `pystray`, `Pillow`)
   - Windows 시작 폴더에 바로가기 등록 (다음 재부팅부터 자동 실행)

## 바로 실행 (설치 후)

- `start.bat` 더블클릭 → 트레이 아이콘(파란 배경 + "V")이 작업 표시줄에 나타남
- 다음 Windows 재부팅부터는 자동 실행

## 확인 — 서버가 떠 있나?

```powershell
curl http://127.0.0.1:5555/health
```

응답 예시:
```json
{"status":"ok","version":"1.0.0","service":"venue-finder-converter"}
```

## 수동 테스트 — 폴더 하나 변환해보기

```
test.bat "C:\Users\Minjae\Downloads\test-folder"
```

지정한 폴더(하위 폴더 포함)의 모든 HWP가 PDF로 변환됨.

## 종료

트레이 아이콘 우클릭 → "종료"

## 로그

트레이 아이콘 우클릭 → "로그 보기" 또는 "로그 폴더 열기"

로그 위치: `%APPDATA%\venue-finder-converter\converter.log`

## 트러블슈팅

### "Python이 설치되어 있지 않습니다"
- Python 설치 후 **"Add Python to PATH"** 체크했는지 확인
- 재부팅 또는 새 명령 프롬프트에서 `python --version` 확인

### "pywin32 설치 실패"
- 관리자 권한 명령 프롬프트에서 `pip install pywin32` 재시도

### "한컴 보안 모듈 등록 실패" 로그
- 한컴오피스가 설치되지 않았거나 버전이 너무 낮을 수 있음
- 한컴오피스 최초 1회 수동 실행 후 다시 시도

### 변환이 실패하는 HWP 파일
- DRM/보안 걸린 공공기관 문서는 변환 불가 — 해당 파일은 원본 유지
- 손상된 HWP도 변환 실패 — 로그 확인

### 포트 5555가 이미 사용 중
- 다른 프로그램이 5555 포트를 쓰고 있음
- `app.py`의 `PORT = 5555`를 다른 번호로 변경하고 venue-finder-web의 설정도 함께 변경

## API 명세

### `GET /health`
서버 생존 확인.

응답:
```json
{"status":"ok","version":"1.0.0","service":"venue-finder-converter"}
```

### `POST /convert`
지정 폴더의 모든 HWP를 PDF로 변환.

요청:
```json
{
  "folder": "C:\\Users\\Minjae\\Desktop\\downloads",
  "deleteOriginal": true
}
```

- `folder` (필수): 변환할 HWP가 있는 폴더 (하위 폴더까지 재귀 탐색)
- `deleteOriginal` (옵션, 기본값 `true`): 변환 성공 시 원본 HWP 삭제 여부

응답:
```json
{
  "ok": true,
  "total": 5,
  "success": 4,
  "failed": 1,
  "skipped": 0,
  "results": [
    {"file": "...\\공고문.hwp", "status": "success", "pdf": "...\\공고문.pdf"},
    {"file": "...\\DRM.hwp", "status": "failed", "error": "..."}
  ]
}
```

## 보안

- 서버는 `127.0.0.1`에만 바인딩 → 외부에서 접근 불가
- CORS는 `venue-finder-web.vercel.app`과 localhost만 허용
- 로컬 PC 안에서만 작동. 네트워크 노출 없음.

@echo off
REM venue-finder-converter 설치 스크립트
REM - Python 의존성 설치
REM - Windows 시작 시 자동 실행 등록 (시작 폴더에 바로가기 생성)

setlocal

echo ============================================================
echo venue-finder-converter 설치
echo ============================================================
echo.

REM Python 설치 확인
python --version >nul 2>&1
if errorlevel 1 (
    echo [에러] Python이 설치되어 있지 않습니다.
    echo https://www.python.org/downloads/ 에서 Python 3.10 이상을 설치해 주세요.
    echo 설치 시 "Add Python to PATH" 옵션을 반드시 체크하세요.
    pause
    exit /b 1
)

echo [1/3] Python 의존성 설치 중...
python -m pip install --upgrade pip
python -m pip install -r "%~dp0requirements.txt"
if errorlevel 1 (
    echo [에러] 의존성 설치에 실패했습니다.
    pause
    exit /b 1
)
echo [1/3] 완료.
echo.

echo [2/3] Windows 시작 시 자동 실행 등록 중...
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT_PATH=%STARTUP_DIR%\venue-finder-converter.lnk"
set "APP_PATH=%~dp0start.bat"

REM PowerShell로 바로가기 생성 (아이콘 없는 창을 숨기도록 pythonw.exe 호출)
powershell -NoProfile -Command ^
  "$ws = New-Object -ComObject WScript.Shell; ^
   $s = $ws.CreateShortcut('%SHORTCUT_PATH%'); ^
   $s.TargetPath = '%APP_PATH%'; ^
   $s.WorkingDirectory = '%~dp0'; ^
   $s.WindowStyle = 7; ^
   $s.Save()"

if errorlevel 1 (
    echo [경고] 자동 실행 등록에 실패했습니다. 수동으로 start.bat을 실행하세요.
) else (
    echo [2/3] 완료. ^(%SHORTCUT_PATH%^)
)
echo.

echo [3/3] 설치 완료.
echo.
echo ------------------------------------------------------------
echo 지금 바로 실행하려면: start.bat 더블클릭
echo 다음 Windows 시작부터는 자동 실행됩니다.
echo ------------------------------------------------------------
echo.
pause

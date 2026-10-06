@echo off
REM venue-finder-converter 수동 테스트
REM 사용법: test.bat "C:\변환할\폴더경로"

setlocal

if "%~1"=="" (
    echo 사용법: test.bat "C:\변환할\폴더경로"
    echo 예시: test.bat "C:\Users\Minjae\Downloads\test"
    pause
    exit /b 1
)

echo 서버 상태 확인...
powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:5555/health' -Method Get -TimeoutSec 3; Write-Host ('서버 정상: ' + $r.service + ' v' + $r.version) } catch { Write-Host '서버 응답 없음. start.bat을 먼저 실행하세요.'; exit 1 }"
if errorlevel 1 (
    pause
    exit /b 1
)

echo.
echo 변환 요청: %~1
echo.

powershell -NoProfile -Command ^
  "$body = @{ folder = '%~1'; deleteOriginal = $false } | ConvertTo-Json; ^
   try { ^
     $r = Invoke-RestMethod -Uri 'http://127.0.0.1:5555/convert' -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 300; ^
     Write-Host ('총: ' + $r.total + ', 성공: ' + $r.success + ', 실패: ' + $r.failed + ', 스킵: ' + $r.skipped); ^
     if ($r.results) { $r.results | ForEach-Object { Write-Host ('  [' + $_.status + '] ' + $_.file) } } ^
   } catch { ^
     Write-Host ('에러: ' + $_.Exception.Message) ^
   }"

echo.
pause

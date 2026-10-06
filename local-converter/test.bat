@echo off
chcp 65001 > nul 2>&1
REM venue-finder-converter manual test.
REM Usage: test.bat "C:\path\to\folder"

setlocal

if "%~1"=="" (
    echo Usage: test.bat "C:\path\to\folder"
    echo Example: test.bat "C:\Users\Minjae\Downloads\test"
    pause
    exit /b 1
)

echo Checking server health...
powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:5555/health' -Method Get -TimeoutSec 3; Write-Host ('OK: ' + $r.service + ' v' + $r.version) } catch { Write-Host 'Server not responding. Run start.bat first.'; exit 1 }"
if errorlevel 1 (
    pause
    exit /b 1
)

echo.
echo Converting folder: %~1
echo.

powershell -NoProfile -Command "$body = @{ folder = '%~1'; deleteOriginal = $false } | ConvertTo-Json; try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:5555/convert' -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 300; Write-Host ('Total: ' + $r.total + ', Success: ' + $r.success + ', Failed: ' + $r.failed + ', Skipped: ' + $r.skipped); if ($r.results) { $r.results | ForEach-Object { Write-Host ('  [' + $_.status + '] ' + $_.file) } } } catch { Write-Host ('Error: ' + $_.Exception.Message) }"

echo.
pause

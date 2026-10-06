@echo off
chcp 65001 > nul 2>&1
setlocal

echo ============================================================
echo venue-finder-converter Installer
echo ============================================================
echo.

REM Step 1: Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python is not installed or not in PATH.
    echo.
    echo Please install Python 3.10 or higher from:
    echo   https://www.python.org/downloads/
    echo.
    echo IMPORTANT: During installation, check the box
    echo   "Add Python to PATH"
    echo.
    pause
    exit /b 1
)

echo [1/2] Installing Python dependencies...
python -m pip install --upgrade pip
python -m pip install -r "%~dp0requirements.txt"
if errorlevel 1 (
    echo.
    echo [ERROR] Failed to install Python dependencies.
    echo Try running this as Administrator.
    pause
    exit /b 1
)
echo [1/2] Done.
echo.

echo [2/2] Registering Windows startup shortcut...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0register_startup.ps1" "%~dp0"
if errorlevel 1 (
    echo [WARNING] Could not register startup shortcut.
    echo You can still run start.bat manually.
) else (
    echo [2/2] Done.
)
echo.

echo ============================================================
echo Installation complete.
echo.
echo   To start now: double-click start.bat
echo   Next Windows boot: auto-starts
echo.
echo   Logs: see README.md
echo ============================================================
echo.
pause

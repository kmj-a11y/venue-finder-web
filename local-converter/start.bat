@echo off
REM venue-finder-converter 시작 스크립트
REM pythonw.exe로 실행해 콘솔 창 없이 백그라운드에서 동작 (트레이 아이콘만 보임)

cd /d "%~dp0"
start "" pythonw app.py
exit

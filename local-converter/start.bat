@echo off
REM venue-finder-converter launcher.
REM Starts the app via pythonw.exe (no console window — tray icon only).

cd /d "%~dp0"
start "" pythonw app.py
exit

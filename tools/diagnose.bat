@echo off
rem Double-click: collects a read-only diagnostic report (see diagnose.ps1).
rem Run as a NORMAL user, not "as administrator".
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnose.ps1"
echo.
pause

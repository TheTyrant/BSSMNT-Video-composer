@echo off
rem Starts BSS MNT on this computer (no internet needed) and opens it in Chrome or Edge.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is needed: https://nodejs.org & pause & exit /b 1)
start "" /min cmd /c "node serve.js"
timeout /t 1 /nobreak >nul
start "" "http://127.0.0.1:8765"

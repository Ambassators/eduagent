@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 24 from https://nodejs.org, then open this launcher again.
  pause
  exit /b 1
)
call npm ci --no-audit --no-fund
if errorlevel 1 (pause & exit /b 1)
call npm start
if errorlevel 1 pause

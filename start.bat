@echo off
title Funding Radar v4 — Live Funding Rates
color 0B
echo.
echo  =============================================
echo   Funding Radar v4 — Cross-Exchange Monitor
echo   Binance · Bybit · Bitget · Gate.io · Hyperliquid
echo  =============================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js is not installed!
    echo  Opening download page...
    echo.
    pause
    start https://nodejs.org
    exit /b
)

echo  Node.js found:
node --version
echo.
echo  Installing dependencies (first run only)...
call npm install --silent 2>nul
echo  Dependencies ready.
echo.
echo  =============================================
echo   Starting server on http://localhost:3000
echo  =============================================
echo.
timeout /t 2 /nobreak >nul
start "" http://localhost:3000
echo.
echo  Server is running. Press Ctrl+C to stop.
echo.
node server/index.js
pause
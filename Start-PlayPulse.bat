@echo off
title PlayPulse Intelligence Server
cd /d "%~dp0"

echo.
echo =================================================
echo    PlayPulse Intelligence Launcher
echo =================================================
echo.

:: 1. Verify Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed on this computer.
    echo Please download and install Node.js LTS from: https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: 2. Check if PlayPulse is already running on port 3000
netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul 2>nul
if %errorlevel% equ 0 (
    echo PlayPulse server is already running on port 3000!
    echo Opening http://localhost:3000 in your browser...
    start "" "http://localhost:3000"
    timeout /t 2 /nobreak >nul
    exit /b 0
)

:: 3. First-time setup: auto-install dependencies if node_modules is missing
if not exist "node_modules\" (
    echo First-time setup: Installing required packages...
    call npm install
    if %errorlevel% neq 0 (
        echo.
        echo [ERROR] Package installation failed. Check your internet connection and try again.
        pause
        exit /b 1
    )
)

echo Keep this window open while using PlayPulse.
echo Close this window anytime to stop the server.
echo.

:: 4. Open browser automatically after 2 seconds
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"

:: 5. Start the Node server
node server.mjs

echo.
echo Server stopped.
pause

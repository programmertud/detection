@echo off
title People Detection System - Web Dashboard
echo =======================================================
echo   STARTING PEOPLE DETECTION & MONITORING DASHBOARD
echo =======================================================
cd /d "%~dp0people-detection-web"

if not exist "node_modules" (
    echo [SETUP] First-time setup: installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install encountered an error.
        pause
        exit /b %errorlevel%
    )
)

if not exist ".env" (
    echo [SETUP] Creating local .env from .env.example...
    copy .env.example .env
)

echo.
echo [SERVER] Launching Vite Local Development Server...
echo [SERVER] Dashboard will be accessible at: http://localhost:3000
echo.
call npm run dev
pause

@echo off
title People Detection System - ESP32-S3 Telemetry Simulator
echo =======================================================
echo   STARTING ESP32-S3 HARDWARE TELEMETRY SIMULATOR
echo =======================================================
cd /d "%~dp0"

node scripts/simulate_sensor.js
pause

@echo off
rem ============================================================================
rem  FL Server launcher - starts the local server for Film Library
rem  Prefers Node (server.js); falls back to Python (server.py).
rem  The server opens your browser automatically. Keep this window open.
rem ============================================================================
setlocal EnableExtensions
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel%==0 (
  node server.js
  if %errorlevel% neq 0 pause
  goto :eof
)

where py >nul 2>nul
if %errorlevel%==0 (
  py server.py
  if %errorlevel% neq 0 pause
  goto :eof
)

where python >nul 2>nul
if %errorlevel%==0 (
  python server.py
  if %errorlevel% neq 0 pause
  goto :eof
)

echo [FL Server] Node.js or Python was not found on this PC.
echo [FL Server] Install either one ^(both are free^), then double-click this file again.
pause

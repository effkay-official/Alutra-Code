@echo off
REM Alutra Code - public internet launcher using Cloudflare Tunnel
REM Requires: node, cloudflared (auto-installed to %LOCALAPPDATA%\cloudflared if missing)

setlocal
cd /d "%~dp0"

REM Ensure cloudflared is available
where cloudflared >nul 2>nul
if %errorlevel%==0 (set CFLDDIR=) else (
   set "CFLDIR=%LOCALAPPDATA%\cloudflared\cloudflared.exe"
   if not exist "%CFLDIR%" (
       echo Downloading cloudflared...
       powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile '%LOCALAPPDATA%\cloudflared\cloudflared.exe'"
   )
)

REM Start the API+static server in a new window
start "Alutra Code API" cmd /k "cd /d %~dp0 && node server/src/index.js"

echo.
echo Waiting for the API to come up on http://localhost:8787 ...
powershell -NoProfile -Command "1..30 | ForEach-Object { try { $r = Invoke-WebRequest -Uri 'http://localhost:8787/api/providers' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch { Start-Sleep -Milliseconds 1000 } }; exit 1"
if not %errorlevel%==0 (
   echo Server did not start. Check the API window for errors.
   pause
   exit /b 1
)

echo Server is up. Starting Cloudflare Tunnel...
if defined CFLDIR (
   "%CFLDIR%" tunnel --url http://localhost:8787
) else (
   cloudflared tunnel --url http://localhost:8787
)

echo.
echo Tunnel closed. The API window will keep running until you close it.
pause
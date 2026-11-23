@echo off
rem YoYoCanvas Local - one-click start (Windows)
rem Runtime layout (ship-with-package):
rem   runtime\bun\bun.exe        - Bun runtime (from https://bun.sh, windows x64 build)
rem   runtime\ffmpeg\ffmpeg.exe + ffprobe.exe - media tools (static build)
rem Data lives in .\data\ (app.db / blobs / yoyo-canvas-projects).
setlocal
cd /d "%~dp0"

if exist "runtime\bun\bun.exe" (
  set "BUN_EXE=%CD%\runtime\bun\bun.exe"
  goto :bun_ready
)
where bun >nul 2>nul
if not errorlevel 1 (
  set "BUN_EXE=bun"
  goto :bun_ready
)
if exist "%USERPROFILE%\.bun\bin\bun.exe" goto :use_user_bun

echo Bun not found. Installing Bun...
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://bun.sh/install.ps1 | iex" || goto :fail
if exist "%USERPROFILE%\.bun\bin\bun.exe" goto :use_user_bun
where bun >nul 2>nul
if not errorlevel 1 (
  set "BUN_EXE=bun"
  goto :bun_ready
)
echo Failed to locate bun after installation.
goto :fail

:use_user_bun
set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
set "BUN_EXE=%USERPROFILE%\.bun\bin\bun.exe"

:bun_ready

if exist "runtime\ffmpeg\ffmpeg.exe" goto :use_local_ffmpeg
where ffmpeg >nul 2>nul
if not errorlevel 1 goto :ffmpeg_ready
if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe" goto :use_winget_ffmpeg

where winget >nul 2>nul
if errorlevel 1 goto :ffmpeg_ready

echo ffmpeg not found. Installing ffmpeg via winget...
winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe" goto :use_winget_ffmpeg
goto :ffmpeg_ready

:use_local_ffmpeg
set "PATH=%CD%\runtime\ffmpeg;%PATH%"
set "FFMPEG_PATH=%CD%\runtime\ffmpeg\ffmpeg.exe"
set "FFPROBE_PATH=%CD%\runtime\ffmpeg\ffprobe.exe"
goto :ffmpeg_ready

:use_winget_ffmpeg
set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links;%PATH%"

:ffmpeg_ready
where ffmpeg >nul 2>nul || echo [warn] ffmpeg not found: video tool nodes (frames / extract audio / compose / poster) unavailable.
where ffprobe >nul 2>nul || echo [warn] ffprobe not found: media size probing unavailable.

if exist "runtime\cloudflared\cloudflared.exe" goto :use_local_cloudflared
where cloudflared >nul 2>nul
if not errorlevel 1 goto :cloudflared_ready
if exist "%ProgramFiles%\cloudflared\cloudflared.exe" goto :cloudflared_ready
if exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" goto :cloudflared_ready
if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\cloudflared.exe" goto :use_winget_cloudflared
if exist "%LOCALAPPDATA%\Microsoft\WindowsApps\cloudflared.exe" goto :cloudflared_ready

where winget >nul 2>nul
if errorlevel 1 goto :cloudflared_ready

echo cloudflared not found. Installing cloudflared via winget...
winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\cloudflared.exe" goto :use_winget_cloudflared
goto :cloudflared_ready

:use_local_cloudflared
set "PATH=%CD%\runtime\cloudflared;%PATH%"
goto :cloudflared_ready

:use_winget_cloudflared
set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links;%PATH%"

:cloudflared_ready
where cloudflared >nul 2>nul || if not exist "%ProgramFiles%\cloudflared\cloudflared.exe" if not exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" if not exist "%LOCALAPPDATA%\Microsoft\WindowsApps\cloudflared.exe" echo [warn] cloudflared not found: bridge tunnel setup in /bridge-admin will require manual install.

if not exist "node_modules" (
  echo First run: installing dependencies...
  "%BUN_EXE%" install || goto :fail
)

if not exist "client\dist\index.html" (
  echo First run: building client...
  "%BUN_EXE%" run build:client || goto :fail
)

echo Starting YoYoCanvas Local at http://127.0.0.1:3737
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:3737"
"%BUN_EXE%" .\local\server.ts || goto :fail
goto :eof

:fail
echo.
echo Start failed. See messages above.
pause
exit /b 1

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
) else (
  set "BUN_EXE=bun"
)

if exist "runtime\ffmpeg" (
  set "PATH=%CD%\runtime\ffmpeg;%PATH%"
  set "FFMPEG_PATH=%CD%\runtime\ffmpeg\ffmpeg.exe"
  set "FFPROBE_PATH=%CD%\runtime\ffmpeg\ffprobe.exe"
)

where ffmpeg >nul 2>nul || echo [warn] ffmpeg not found: video tool nodes (frames / extract audio / compose / poster) unavailable.
where ffprobe >nul 2>nul || echo [warn] ffprobe not found: media size probing unavailable.

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
"%BUN_EXE%" .\local\server.ts
goto :eof

:fail
echo.
echo Start failed. See messages above.
pause
exit /b 1

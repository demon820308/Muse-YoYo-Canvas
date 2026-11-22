@echo off
setlocal
cd /d "%~dp0"

if exist "runtime\bun\bun.exe" (
  set "BUN_EXE=%CD%\runtime\bun\bun.exe"
) else (
  set "BUN_EXE=bun"
)

if exist "runtime\ffmpeg" (
  set "PATH=%CD%\runtime\ffmpeg;%PATH%"
)

"%BUN_EXE%" .\scripts\diagnose.ts
echo.
pause

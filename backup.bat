@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

if not exist "data" (
  echo [INFO] No data directory yet, nothing to back up.
  pause
  exit /b 0
)

for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value 2^>nul') do set "DT=%%I"
if defined DT (
  set "STAMP=%DT:~0,8%-%DT:~8,6%"
) else (
  set "STAMP=manual"
)
set "TARGET=backup\data-%STAMP%"

if not exist "%TARGET%" mkdir "%TARGET%"
xcopy "data" "%TARGET%" /E /I /Y >nul || goto :fail

echo Backed up data\ to %TARGET%
pause
exit /b 0

:fail
echo [ERROR] Backup failed.
pause
exit /b 1

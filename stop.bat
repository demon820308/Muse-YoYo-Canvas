@echo off
setlocal
set "PORT=%YOYO_LOCAL_PORT%"
if "%PORT%"=="" set "PORT=3737"

echo Stopping YoYoCanvas Local on port %PORT%...
for /f "tokens=5" %%A in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do (
  taskkill /F /PID %%A >nul 2>&1
)
echo Done.
timeout /t 2 >nul

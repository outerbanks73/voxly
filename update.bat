@echo off
REM SpeakToText Local - Update Script for Windows
REM Updates the application to the latest version from GitHub

echo ========================================
echo   SpeakToText Local - Update Script
echo ========================================
echo.

REM Get current directory
set SCRIPT_DIR=%~dp0
cd /d "%SCRIPT_DIR%"

REM Check if git is available
where git >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo Error: git is not installed.
    echo Please install git and try again.
    pause
    exit /b 1
)

REM Check if we're in a git repo
if not exist ".git" (
    echo Error: This doesn't appear to be a git repository.
    echo Please run this script from the speaktotext-local directory.
    pause
    exit /b 1
)

REM Get current version
for /f "tokens=2 delims=:, " %%a in ('findstr /C:"\"version\"" extension\manifest.json') do (
    set CURRENT_VERSION=%%~a
    goto :found_version
)
:found_version
echo Current version: %CURRENT_VERSION%

REM Fetch latest from remote
echo.
echo Fetching updates from GitHub...
git fetch origin main

REM Check if there are updates
for /f %%i in ('git rev-parse HEAD') do set LOCAL=%%i
for /f %%i in ('git rev-parse origin/main') do set REMOTE=%%i

if "%LOCAL%"=="%REMOTE%" (
    echo.
    echo You're already on the latest version!
    pause
    exit /b 0
)

REM Show what's new
echo.
echo Updates available!
echo.
echo Changes since your version:
git log --oneline HEAD..origin/main
echo.

REM Pull updates
echo Downloading updates...
git pull origin main

REM Get new version
for /f "tokens=2 delims=:, " %%a in ('findstr /C:"\"version\"" extension\manifest.json') do (
    set NEW_VERSION=%%~a
    goto :found_new_version
)
:found_new_version
echo.
echo Updated from v%CURRENT_VERSION% to v%NEW_VERSION%

REM Check if server is running and restart it
echo.
echo Checking for running server...
tasklist /FI "WINDOWTITLE eq SpeakToText*" 2>nul | find /I "python" >nul
if %ERRORLEVEL% equ 0 (
    echo Stopping existing server...
    taskkill /F /FI "WINDOWTITLE eq SpeakToText*" >nul 2>nul
    timeout /t 2 >nul

    echo Starting updated server...
    start "SpeakToText Server" cmd /c "cd server && venv\Scripts\activate && python server.py"
    timeout /t 2 >nul
    echo Server restarted
) else (
    echo Server not running. Start it with: start-server.bat
)

echo.
echo ========================================
echo   Update Complete!
echo ========================================
echo.
echo Next steps:
echo 1. Go to chrome://extensions
echo 2. Find 'SpeakToText Local'
echo 3. Click the refresh/reload icon
echo.
echo Enjoy the new features!
echo.
pause

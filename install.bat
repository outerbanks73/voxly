@echo off
REM SpeakToText Local - Windows Installer

echo ==============================================
echo   SpeakToText Local - Installer
echo ==============================================
echo.

REM Check for Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Python not found
    echo Please install Python 3.9+ from https://python.org
    pause
    exit /b 1
)

echo [OK] Python found

REM Check for ffmpeg
ffmpeg -version >nul 2>&1
if %errorlevel% neq 0 (
    echo WARNING: ffmpeg not found
    echo Please install ffmpeg from https://ffmpeg.org/download.html
    echo Add ffmpeg to your PATH after installation
    pause
)

REM Get script directory
set "SCRIPT_DIR=%~dp0"
set "SERVER_DIR=%SCRIPT_DIR%server"
set "VENV_DIR=%SERVER_DIR%\venv"

REM Create virtual environment
echo.
echo Setting up Python virtual environment...

if exist "%VENV_DIR%" (
    echo Virtual environment exists, updating...
) else (
    python -m venv "%VENV_DIR%"
    echo [OK] Virtual environment created
)

REM Activate and install dependencies
call "%VENV_DIR%\Scripts\activate.bat"

echo Installing Python dependencies (this may take a few minutes)...
pip install --upgrade pip >nul 2>&1
pip install -r "%SERVER_DIR%\requirements.txt"

echo [OK] Dependencies installed

REM Create launcher
echo.
echo Creating launcher...

(
echo @echo off
echo call "%VENV_DIR%\Scripts\activate.bat"
echo python "%SERVER_DIR%\server.py"
echo pause
) > "%SCRIPT_DIR%start-server.bat"

echo [OK] Launcher created: start-server.bat

echo.
echo ==============================================
echo   Installation Complete!
echo ==============================================
echo.
echo Next steps:
echo.
echo 1. Start the server:
echo    Double-click start-server.bat
echo.
echo 2. Install the Chrome extension:
echo    - Open Chrome: chrome://extensions
echo    - Enable 'Developer mode' (top right)
echo    - Click 'Load unpacked'
echo    - Select the 'extension' folder
echo.
echo 3. (Optional) Configure speaker diarization:
echo    - Click the extension icon then Settings
echo    - Add your Hugging Face token
echo.
pause

@echo off
REM ============================================================
REM  Astra Browser - paylasilabilir SETUP (kurulum) dosyasi uretir
REM  Cikti: dist\AstraBrowser-Setup-1.0.0.exe
REM ============================================================
setlocal
cd /D "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
    echo Node.js/NPM bulunamadi. https://nodejs.org adresinden kurun.
    exit /b 1
)

echo [1/2] Bagimliliklar indiriliyor (electron 11.5 + electron-builder)...
call npm install
if errorlevel 1 ( echo npm install basarisiz & exit /b 1 )

echo [2/2] Setup dosyasi uretiliyor...
call npm run dist
if errorlevel 1 ( echo build basarisiz & exit /b 1 )

echo.
echo TAMAM. Cikti: %~dp0dist\AstraBrowser-Setup-1.0.0.exe
endlocal

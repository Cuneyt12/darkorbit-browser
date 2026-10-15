@echo off
REM ============================================================
REM  darkorbit-browser.jar -> "DarkOrbit Browser.exe" (Launch4j)
REM
REM  Onkosul: libs\jcef.jar mevcut olmali (CEF 87 ile derlenmis JCEF).
REM  Launch4j yoksa: https://launch4j.sourceforge.net -> indir/kur,
REM  gerekirse LAUNCH4J ortam degiskenini launch4j.exe yoluna ayarla.
REM ============================================================
setlocal

set "HERE=%~dp0"

REM 1) Jar'i derle
where mvn >nul 2>nul
if %errorlevel%==0 (
    echo [1/2] Maven ile derleniyor...
    call mvn -f "%HERE%pom.xml" -q package
    if errorlevel 1 (
        echo Maven derlemesi basarisiz.
        exit /b 1
    )
) else (
    echo [1/2] Maven bulunamadi, mevcut target\darkorbit-browser.jar kullanilacak.
)

if not exist "%HERE%target\darkorbit-browser.jar" (
    echo HATA: target\darkorbit-browser.jar bulunamadi.
    exit /b 1
)

REM 2) Launch4j ile exe uret (Launch4j config'i jar'i target altindan degil,
REM    config'in bulundugu klasorden arar; bu yuzden jar'i buraya kopyaliyoruz)
copy /Y "%HERE%target\darkorbit-browser.jar" "%HERE%darkorbit-browser.jar" >nul

set "L4J=%LAUNCH4J%"
if "%L4J%"=="" set "L4J=C:\Program Files (x86)\Launch4j\launch4j.exe"
if not exist "%L4J%" set "L4J=C:\Program Files\Launch4j\launch4j.exe"
if not exist "%L4J%" (
    echo.
    echo Launch4j bulunamadi. Indir: https://launch4j.sourceforge.net
    echo Kurduktan sonra: set "LAUNCH4J=C:\...\launch4j.exe"  ve tekrar calistir.
    exit /b 1
)

echo [2/2] Launch4j ile exe uretiliyor...
"%L4J%" "%HERE%launch4j.xml"
if errorlevel 1 (
    echo Launch4j basarisiz.
    exit /b 1
)

echo.
echo Cikti: "%HERE%DarkOrbit Browser.exe"
echo Bu exe'yi kurulum klasorune koy:
echo   %LOCALAPPDATA%\Programs\darkorbit-browser\
echo (yaninda jcef\ ve flash\pepflashplayer.dll olmali)
endlocal

@echo off
REM ============================================================
REM  DarkOrbit Browser (Java + JCEF/CEF87 + Pepper Flash) launcher
REM  Kullanim:  run.bat --dosid "https://int1.darkorbit.com/indexInternal.es?dosid=XXXX"
REM ============================================================
setlocal

set "HERE=%~dp0"
set "JCEF=%HERE%jcef"

REM Native DLL klasorlerini bul (JCEF distrib yapisina gore)
set "NATIVE=%JCEF%\bin"
if exist "%JCEF%\bin\lib" set "NATIVE=%NATIVE%;%JCEF%\bin\lib"
if exist "%JCEF%\bin\lib\win64" set "NATIVE=%NATIVE%;%JCEF%\bin\lib\win64"
if exist "%JCEF%\lib" set "NATIVE=%NATIVE%;%JCEF%\lib"
if exist "%JCEF%\lib\win64" set "NATIVE=%NATIVE%;%JCEF%\lib\win64"

REM Classpath
set "CP=%HERE%darkorbit-browser.jar"
if exist "%JCEF%\jcef.jar" set "CP=%CP%;%JCEF%\jcef.jar"
if exist "%JCEF%\bin\jcef.jar" set "CP=%CP%;%JCEF%\bin\jcef.jar"

REM PATH'e de ekle (libcef.dll bagimliliklari icin)
set "PATH=%NATIVE%;%PATH%"

java -Dfile.encoding=UTF-8 -Djava.library.path="%NATIVE%" -cp "%CP%" com.cuneyt.darkorbitbrowser.BackpageBrowser %*

endlocal

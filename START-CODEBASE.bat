@echo off
setlocal
cd /d "%~dp0"

rem 1) O'rnatilgan CodeBase (installer orqali)
if exist "%LocalAppData%\Programs\CodeBase\CodeBase.exe" (
  start "" "%LocalAppData%\Programs\CodeBase\CodeBase.exe"
  exit /b 0
)
if exist "%ProgramFiles%\CodeBase\CodeBase.exe" (
  start "" "%ProgramFiles%\CodeBase\CodeBase.exe"
  exit /b 0
)

rem 2) Yig'ilgan, lekin o'rnatilmagan versiya
if exist "%~dp0release\win-unpacked\CodeBase.exe" (
  start "" "%~dp0release\win-unpacked\CodeBase.exe"
  exit /b 0
)

rem 3) Manba koddan ishga tushirish (dev)
if exist "%~dp0node_modules\electron" (
  echo CodeBase manba koddan ishga tushirilmoqda...
  call npm run build
  call npx electron .
  exit /b 0
)

echo CodeBase topilmadi.
echo Avval BUILD-WINDOWS-APP.bat faylini ishga tushirib, installerni o'rnating.
pause
exit /b 1

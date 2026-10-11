@echo off
setlocal
cd /d "%~dp0"
title CodeBase Agent Builder
echo =========================================
echo   CodeBase Agent 1.0 - Windows Installer
echo =========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo XATO: Node.js topilmadi. https://nodejs.org dan LTS versiyasini o'rnating.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do echo Node %%v
echo.

rem Eski CodeBase ma'lumotlarini yo'qotmaslik uchun AppData'ga ko'chirish.
if exist "%~dp0backend\data\store.json" if not exist "%APPDATA%\CodeBase\data\store.json" (
  if not exist "%APPDATA%\CodeBase\data" mkdir "%APPDATA%\CodeBase\data"
  copy /Y "%~dp0backend\data\store.json" "%APPDATA%\CodeBase\data\store.json" >nul
  echo Eski chat va project xotirasi AppData papkasiga ko'chirildi.
)

echo [1/6] Root paketlar o'rnatilmoqda...
call npm install
if errorlevel 1 goto failed

echo.
echo [2/6] Backend paketlari...
call npm --prefix backend install
if errorlevel 1 goto failed

echo.
echo [3/6] Frontend paketlari...
call npm --prefix frontend install
if errorlevel 1 goto failed

echo.
echo [4/6] Testlar ishga tushirilmoqda (123 test)...
call npm --prefix backend test
if errorlevel 1 (
  echo OGOHLANTIRISH: testlar muvaffaqiyatsiz tugadi. Build davom etadi, lekin logni tekshiring.
)

echo.
echo [5/6] Backend va frontend yig'ilmoqda...
call npm run build
if errorlevel 1 goto failed

echo.
echo [6/6] Windows installer yig'ilmoqda (birinchi safar Electron/NSIS yuklanadi)...
call npx electron-builder --win nsis --x64
if errorlevel 1 goto failed

echo.
echo =========================================
echo   MUVAFFAQIYATLI!
echo   Installer: %~dp0release
echo =========================================
start "" explorer "%~dp0release"
pause
exit /b 0

:failed
echo.
echo =========================================
echo   BUILD XATOSI - yuqoridagi xabarni o'qib, yana urinib ko'ring.
echo =========================================
pause
exit /b 1

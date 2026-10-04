@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "KICKSPHERE_NODE=node"
if exist "%ProgramFiles%\nodejs\node.exe" set "KICKSPHERE_NODE=%ProgramFiles%\nodejs\node.exe"
"%KICKSPHERE_NODE%" "%~dp0scripts\local-android-runtime.js" %*
set "KICKSPHERE_EXIT=%ERRORLEVEL%"
if /I "%~1"=="--check" exit /b %KICKSPHERE_EXIT%
echo.
echo Keep this file available for your next local test.
pause
exit /b %KICKSPHERE_EXIT%

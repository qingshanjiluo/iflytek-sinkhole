@echo off
rem ============================================================================
rem  iflytek-sinkhole Management Center (portable, no exe)
rem  Double-click -> UAC (auto-elevation with limited-mode fallback) -> menu
rem  Copy THIS WHOLE FOLDER anywhere and it keeps working (all paths relative).
rem  Chinese menu text is printed by node (mgmt.js), this file stays ASCII on
rem  purpose so it survives any system codepage (GBK/UTF-8/Win7 default).
rem
rem  Node pick order (Win7 auto-adapt):
rem    1) runtime-win7\node.exe   (put Node 14 portable here on Windows 7)
rem    2) runtime\node.exe        (bundled, needs Win10+)
rem    3) node.exe on PATH        (system install)
rem  Each candidate is smoke-tested with `-v` - a Node that cannot run on THIS
rem  OS (e.g. Node 20+ on Win7) automatically falls through to the next.
rem ============================================================================
setlocal EnableExtensions
cd /d "%~dp0"
title iflytek-sinkhole Management Center

rem ---- admin check: net session OR fltmc (either success = elevated) ----
net session >nul 2>&1
if not errorlevel 1 goto :have_admin
fltmc >nul 2>&1
if not errorlevel 1 goto :have_admin

rem ---- not elevated: ask for UAC once ----
echo [UAC] Requesting administrator rights...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs" >nul 2>&1
if not errorlevel 1 exit /b
echo [WARN] Elevation declined - LIMITED MODE.
echo        View status / edit config / open console still work.
echo        Install, uninstall, hotspot and service start will report
echo        "admin required".  Re-run this bat as admin when needed.
echo.

:have_admin
rem ---- node discovery with runtime probes ----
set "NODEBIN="
call :probe "%~dp0runtime-win7\node.exe"
if defined NODEBIN goto :node_ok
call :probe "%~dp0runtime\node.exe"
if defined NODEBIN goto :node_ok
call :probe "node.exe"
if defined NODEBIN goto :node_ok

echo [FATAL] No usable Node.js found. Fixes:
echo   * Windows 7/8: copy a Node 14 portable "node.exe" into  runtime-win7\
echo   * Windows 10+: restore runtime\node.exe (re-extract the package) or
echo     install Node from https://nodejs.org and re-run this bat.
echo.
pause
exit /b 1

:probe
if not exist %1 exit /b
%1 -v >nul 2>&1
if not errorlevel 1 set "NODEBIN=%~1"
exit /b

:node_ok
"%NODEBIN%" "%~dp0mgmt.js" %*
set "EC=%errorlevel%"
if not "%EC%"=="0" (
  echo.
  echo [exit %EC%] If this window closed unexpectedly, re-run from an
  echo already-open terminal to keep the message:  mgmt.js check
  pause
)
exit /b %EC%

@echo off
setlocal
set "codexShell=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
where pwsh.exe >nul 2>&1
if not errorlevel 1 set "codexShell=pwsh.exe"
echo Codex Web - %~n0
"%codexShell%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dpn0.ps1" -Background %*
set "codexExit=%errorlevel%"
echo.
if not "%codexExit%"=="0" echo Command failed with exit code %codexExit%.
pause
exit /b %codexExit%

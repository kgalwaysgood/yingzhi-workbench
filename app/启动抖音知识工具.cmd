@echo off
set "TOOL_DIR=%~dp0"
where pwsh.exe >nul 2>nul
if %errorlevel%==0 (
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%TOOL_DIR%launcher.ps1"
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%TOOL_DIR%launcher.ps1"
)
if errorlevel 1 (
  echo.
  echo Launcher failed. Keep this window open and review the error above.
  pause
)

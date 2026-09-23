@echo off
setlocal
set "BUILD_FILE=%~dp0desktop\current-build.txt"
if not exist "%BUILD_FILE%" goto missing
set /p BUILD=<"%BUILD_FILE%"
set "APP=%~dp0desktop\dist\%BUILD%\%BUILD%.exe"
if not exist "%APP%" goto missing
start "" "%APP%"
exit /b 0

:missing
echo Native desktop EXE is missing.
echo Expected: "%APP%"
pause
exit /b 1

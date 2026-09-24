@echo off
rem Starts the PlexTogether dev server. Double-click this file, or run it from cmd.
rem Stop the server with Ctrl+C in this window.

rem Run from this file's folder, wherever it was launched from.
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies...
  call npm install || goto :error
)

echo Starting PlexTogether at http://localhost:3000
rem Open the browser once the server has had a moment to start.
start "" /b cmd /c "timeout /t 4 >nul & start http://localhost:3000"
call npm run dev
goto :eof

:error
echo.
echo npm install failed. See the messages above.
pause

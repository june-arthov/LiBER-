@echo off
rem Double-click entry point: starts the wizard with the right execution policy.
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0LiBER-Setup.ps1" %*
if errorlevel 1 pause

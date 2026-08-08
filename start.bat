@echo off
setlocal
call npm run install:all
if errorlevel 1 exit /b %errorlevel%
call npm run dev

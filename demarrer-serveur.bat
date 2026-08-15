@echo off
title GESCOM - Serveur de synchronisation
cd /d "%~dp0"
echo ============================================================
echo   GESCOM - Serveur de licences + synchronisation cloud
echo   Laissez cette fenetre ouverte tant que vous utilisez
echo   la synchronisation multi-appareils (PC + telephone).
echo ============================================================
echo.
call npm start
pause

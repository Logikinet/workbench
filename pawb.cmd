@echo off
REM Windows helper: run CLI from repo root without global install
setlocal
cd /d "%~dp0"
call npx --yes tsx apps/cli/src/main.ts %*

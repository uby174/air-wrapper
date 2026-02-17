@echo off
cd /d "c:\Users\engra\Downloads\purify_proper (1)\ai-wrapper"
"C:\Program Files\nodejs\corepack.cmd" pnpm --filter @ai-wrapper/web dev >> "%cd%\web-dev.log" 2>&1

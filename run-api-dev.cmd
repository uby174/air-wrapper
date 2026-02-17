@echo off
cd /d "c:\Users\engra\Downloads\purify_proper (1)\ai-wrapper"
"C:\Program Files\nodejs\corepack.cmd" pnpm --filter @ai-wrapper/api dev >> "%cd%\api-dev.log" 2>&1

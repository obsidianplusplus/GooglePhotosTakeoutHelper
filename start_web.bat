@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js。请安装 Node.js 20.19 或更高版本后重试。
  echo        下载地址：https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\sharp" (
  echo 首次运行，正在安装 Node.js 依赖...
  call npm install
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络或手动执行 npm install。
    pause
    exit /b 1
  )
)

echo 正在启动 PhotoTakeout Studio...
node "src\cli.js" web
set code=%errorlevel%
if not "%code%"=="0" (
  echo.
  echo 程序退出，代码 %code%。
  pause
)
exit /b %code%

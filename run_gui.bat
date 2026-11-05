@echo off
setlocal
REM 双击启动 PhotoTakeout Studio 网页界面（Node.js 版本）。
REM 旧版 Python 桌面界面已在 v5.0.0 移除；如需历史实现请查看 Git 历史。
call "%~dp0start_web.bat"
exit /b %errorlevel%

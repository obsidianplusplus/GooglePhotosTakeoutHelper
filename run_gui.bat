@echo off
setlocal

REM 始终从项目根目录启动，避免双击时工作目录不正确
cd /d "%~dp0"

REM 优先使用项目虚拟环境中的 Python
if exist ".venv\Scripts\python.exe" goto use_venv

REM 其次尝试 Windows Python 启动器
where py >nul 2>nul
if not errorlevel 1 goto use_py

REM 最后尝试环境变量 PATH 中的 Python
where python >nul 2>nul
if not errorlevel 1 goto use_python

echo 未找到 Python。请先安装 Python 3.10 或更高版本。
pause
exit /b 1

:use_venv
".venv\Scripts\python.exe" -m gpth
exit /b %errorlevel%

:use_py
py -3 -m gpth
exit /b %errorlevel%

:use_python
python -m gpth
exit /b %errorlevel%

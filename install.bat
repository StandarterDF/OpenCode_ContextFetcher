@echo off
setlocal
chcp 65001 >nul

rem Установка плагина в глобальный каталог OpenCode:
rem   %USERPROFILE%\.config\opencode\plugins\localai-context\
rem Это каталог глобальных плагинов OpenCode V2.
rem Если у тебя задан XDG_CONFIG_HOME, поправь CONFIG_DIR ниже.

set "SRC=%~dp0plugin"
set "CONFIG_DIR=%USERPROFILE%\.config\opencode"
set "DST=%CONFIG_DIR%\plugins\localai-context"

if not exist "%SRC%\index.js" (
  echo [ERROR] Не найден "%SRC%\index.js". Запусти install.bat из корня репозитория.
  pause
  exit /b 1
)

if not exist "%DST%" mkdir "%DST%"

xcopy "%SRC%\index.js" "%DST%\" /Y >nul
xcopy "%SRC%\package.json" "%DST%\" /Y >nul

echo [OK] Плагин установлен в: %DST%
echo.
echo ВАЖНО: в "%CONFIG_DIR%\opencode.json" у модели LocalAI/Qwen3-Coder
echo не должен быть задан "limit.context" (и вообще "limit") -- иначе он
echo перебьёт плагин и автоопределение контекста работать не будет.
echo.
echo После правки конфига перезапусти сервис: opencode service restart
echo.

pause

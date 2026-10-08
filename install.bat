@echo off
setlocal
chcp 65001 >nul

rem Установка плагина в глобальный каталог OpenCode:
rem   %USERPROFILE%\.config\opencode\plugins\localai-discovery\
rem Это каталог глобальных плагинов OpenCode V2.
rem Если у тебя задан XDG_CONFIG_HOME, поправь CONFIG_DIR ниже.

set "SRC=%~dp0plugin"
set "CONFIG_DIR=%USERPROFILE%\.config\opencode"
set "DST=%CONFIG_DIR%\plugins\localai-discovery"
set "LEGACY=%CONFIG_DIR%\plugins\localai-context"

if not exist "%SRC%\index.js" (
  echo [ERROR] Не найден "%SRC%\index.js". Запусти install.bat из корня репозитория.
  pause
  exit /b 1
)

if not exist "%DST%" mkdir "%DST%"

xcopy "%SRC%\index.js" "%DST%\" /Y >nul
xcopy "%SRC%\package.json" "%DST%\" /Y >nul

if exist "%LEGACY%" (
  rmdir /s /q "%LEGACY%"
  echo [OK] Удалён устаревший плагин: %LEGACY%
)

echo [OK] Плагин установлен в: %DST%
echo.
echo Плагин делает локальные модели доступными как aliases на активном
echo провайдере (по умолчанию "opencode"), напр. opencode/local-<model>.
echo Дополнительная настройка в opencode.json не нужна.
echo.
echo Если сервис не подхватил плагин сам - перезапусти его: opencode service restart
echo.

pause
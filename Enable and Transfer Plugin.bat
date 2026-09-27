@echo off
setlocal EnableExtensions EnableDelayedExpansion

echo =========================================
echo Choice Stream Backend Installer
echo =========================================
echo This script will install the backend database router into SillyTavern.
echo DANGER/WARNING: This will modify your config.yaml to set
echo 'enableServerPlugins: true'.
echo.
echo Allowing Server Plugins means any GitHub extension with a backend
echo script can execute Node.js code on your machine.
echo Ensure you only install extensions you trust.
echo =========================================
echo.

set /p "CHOICE=Do you wish to proceed? (Y/n): "

if /I not "%CHOICE%"=="y" (
    echo Installation aborted.
    exit /b 0
)

rem Calculate paths (ST root is 4 directories above this script)
set "CURRENT_DIR=%~dp0"
for %%A in ("%CURRENT_DIR%\..\..\..\..") do set "ST_ROOT=%%~fA"

set "CONFIG_PATH=%ST_ROOT%\config.yaml"
set "PLUGIN_DEST_DIR=%ST_ROOT%\plugins\sillytavern_extension-choices"
set "PLUGIN_DEST_FILE=%PLUGIN_DEST_DIR%\index.js"
set "PLUGIN_SRC_FILE=%CURRENT_DIR%_plugins\index.js"

if not exist "%CONFIG_PATH%" (
    echo [ERROR] Could not find config.yaml at: %CONFIG_PATH%
    echo Are you running this in the right folder?
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$p = [IO.Path]::GetFullPath('%CONFIG_PATH%');" ^
    "$d = [IO.File]::ReadAllText($p);" ^
    "$d = [regex]::Replace($d, 'enableServerPlugins:\s*false', 'enableServerPlugins: true', [Text.RegularExpressions.RegexOptions]::IgnoreCase);" ^
    "[IO.File]::WriteAllText($p, $d, [Text.UTF8Encoding]::new($false))"

if errorlevel 1 (
    echo [ERROR] Failed to modify config.yaml.
    exit /b 1
)
echo [OK] config.yaml updated (enableServerPlugins: true).

if not exist "%PLUGIN_SRC_FILE%" (
    echo [ERROR] Source backend file not found at: %PLUGIN_SRC_FILE%
    echo Create the _plugins\index.js file first.
    exit /b 1
)

if not exist "%PLUGIN_DEST_DIR%" ( mkdir "%PLUGIN_DEST_DIR%" )

copy /Y "%PLUGIN_SRC_FILE%" "%PLUGIN_DEST_FILE%" >nul

if errorlevel 1 (
    echo [ERROR] Failed to copy backend router.
    exit /b 1
)
echo [OK] Backend router installed to: %PLUGIN_DEST_FILE%
echo.
echo SUCCESS! You must completely restart the SillyTavern command console/Start.bat for the backend to load.
echo.
pause
endlocal
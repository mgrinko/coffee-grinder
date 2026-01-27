@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

:: Add missed news articles to existing presentation
:: Usage: 4.add_missed.bat [url] [--topic "Topic Name"] [--priority N]

cd /d "%~dp0grinder"

if "%~1"=="" (
    echo.
    echo Usage: 4.add_missed.bat "URL" [--topic "Topic"] [--priority N]
    echo.
    echo Examples:
    echo   4.add_missed.bat "https://news.google.com/articles/..."
    echo   4.add_missed.bat "https://example.com/article" --topic "Ukraine" --priority 2
    echo.
    echo Or run without arguments to process articles marked 'add' in Google Sheets.
    echo.
    echo Topics: Big picture, America, Left Is losing it, Ukraine,
    echo         Гадание на кофе, World news, Маразм крепчал, Tech News, Crazy news
    echo.

    :: If no arguments, try to process from sheets
    call npm run add-missed
    goto :end
)

:: Pass all arguments to the npm script
call npm run add-missed -- %*

:end
echo.
pause

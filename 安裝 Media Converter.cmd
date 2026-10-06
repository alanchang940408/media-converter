@echo off
rem Media Converter installer: downloads the latest installer from GitHub Releases and starts it.
rem https://github.com/alanchang940408/media-converter/releases/latest
setlocal
set "REPO=alanchang940408/media-converter"
echo Media Converter - downloading the latest installer from https://github.com/%REPO%/releases/latest
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $h=@{'User-Agent'='media-converter-installer'}; $r=Invoke-RestMethod -Headers $h -Uri 'https://api.github.com/repos/%REPO%/releases/latest'; $a=$r.assets | Where-Object { $_.name -match 'Setup-.*\.exe$' } | Select-Object -First 1; if (-not $a) { throw 'No installer in the latest release.' }; $out=Join-Path $env:TEMP $a.name; Write-Host ('Version ' + $r.tag_name + ' - ' + $a.name + ' (' + [math]::Round($a.size/1MB) + ' MB)'); Invoke-WebRequest -UseBasicParsing -Headers $h -Uri $a.browser_download_url -OutFile $out; Write-Host 'Starting the installer...'; Start-Process -FilePath $out"
if errorlevel 1 goto failed
endlocal
exit /b 0

:failed
echo.
echo Download failed. Open https://github.com/%REPO%/releases/latest in a browser
echo and download Media-Converter-Setup-x.y.z.exe manually.
pause
endlocal
exit /b 1

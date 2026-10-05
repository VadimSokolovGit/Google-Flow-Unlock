# Packaging script for Chrome and Firefox extensions
$distDir = Join-Path $PSScriptRoot "dist"
if (!(Test-Path $distDir)) {
    New-Item -ItemType Directory -Path $distDir | Out-Null
}

$chromeZip = Join-Path $distDir "google-flow-unlocker-chrome.zip"
$firefoxZip = Join-Path $distDir "google-flow-unlocker-firefox.zip"
$firefoxXpi = Join-Path $distDir "google-flow-unlocker-firefox.xpi"

if (Test-Path $chromeZip) { Remove-Item $chromeZip -Force }
if (Test-Path $firefoxZip) { Remove-Item $firefoxZip -Force }
if (Test-Path $firefoxXpi) { Remove-Item $firefoxXpi -Force }

Compress-Archive -Path "$PSScriptRoot\chrome\*" -DestinationPath $chromeZip -Force
Compress-Archive -Path "$PSScriptRoot\firefox\*" -DestinationPath $firefoxZip -Force
Copy-Item $firefoxZip $firefoxXpi -Force

Write-Host "Build complete! Packages created in dist/:"
Get-ChildItem $distDir | Select-Object Name, Length

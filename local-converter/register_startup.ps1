# register_startup.ps1
# Creates a Windows Startup shortcut for venue-finder-converter.
# Called by install.bat with the app directory as the first argument.

param(
    [Parameter(Mandatory=$true)]
    [string]$AppDir
)

$ErrorActionPreference = 'Stop'

try {
    $AppDir = (Resolve-Path $AppDir).Path
    $startBat = Join-Path $AppDir 'start.bat'

    if (-not (Test-Path $startBat)) {
        Write-Host "ERROR: start.bat not found at $startBat"
        exit 1
    }

    $startupDir = [Environment]::GetFolderPath('Startup')
    $shortcutPath = Join-Path $startupDir 'venue-finder-converter.lnk'

    $ws = New-Object -ComObject WScript.Shell
    $shortcut = $ws.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $startBat
    $shortcut.WorkingDirectory = $AppDir
    $shortcut.WindowStyle = 7  # Minimized
    $shortcut.Description = 'venue-finder-converter HWP to PDF tray server'
    $shortcut.Save()

    Write-Host "Startup shortcut created:"
    Write-Host "  $shortcutPath"
    exit 0
}
catch {
    Write-Host "ERROR: $($_.Exception.Message)"
    exit 1
}

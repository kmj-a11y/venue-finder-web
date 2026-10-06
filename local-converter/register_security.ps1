# register_security.ps1
# Registers the Hancom automation security module so that Hwp does not
# show the "file access approval" dialog during automated conversion.
#
# Registry (official Hancom guide):
#   HKCU\Software\HNC\HwpAutomation\Modules
#     FilePathCheckerModuleExample (REG_SZ) = <full path to DLL>
#
# app.py calls: RegisterModule("FilePathCheckDLL", "FilePathCheckerModuleExample")
# The second argument MUST equal the registry value name above.

param(
    [Parameter(Mandatory=$true)]
    [string]$AppDir
)

$ErrorActionPreference = 'Stop'
$ValueName = 'FilePathCheckerModuleExample'
$RegPath = 'HKCU:\Software\HNC\HwpAutomation\Modules'

try {
    $AppDir = (Resolve-Path ($AppDir.Trim().Trim('"'))).Path
    $dll = Join-Path $AppDir 'FilePathCheckerModuleExample.dll'

    if (-not (Test-Path $dll)) {
        Write-Host "ERROR: DLL not found: $dll"
        exit 1
    }

    if (-not (Test-Path $RegPath)) {
        New-Item -Path $RegPath -Force | Out-Null
    }
    New-ItemProperty -Path $RegPath -Name $ValueName -Value $dll -PropertyType String -Force | Out-Null

    $saved = (Get-ItemProperty -Path $RegPath -Name $ValueName).$ValueName
    Write-Host "Security module registered:"
    Write-Host "  $RegPath"
    Write-Host "  $ValueName = $saved"

    # Report Hwp.exe location (32-bit vs 64-bit install) for troubleshooting.
    $candidates = @(
        "${env:ProgramFiles(x86)}\Hnc",
        "$env:ProgramFiles\Hnc"
    )
    foreach ($root in $candidates) {
        if ($root -and (Test-Path $root)) {
            Get-ChildItem -Path $root -Filter 'Hwp.exe' -Recurse -ErrorAction SilentlyContinue |
                Select-Object -First 1 |
                ForEach-Object { Write-Host "  Hwp.exe found: $($_.FullName)" }
        }
    }
    exit 0
}
catch {
    Write-Host "ERROR: $($_.Exception.Message)"
    exit 1
}

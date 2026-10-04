# Builds haril_native.node using MSBuild + MSVC.
#
# Usage (via package.json scripts):
#   bun run build:native     - builds x64 addon
#   bun run build:native:arm64 - builds arm64 addon
#   bun run build:native:all - builds both x64 and arm64
#
# Requires:
#   - Visual Studio 2022 Build Tools (or any VS with the C++ workload).
#   - Windows 10/11 SDK installed.
#   - node-api-headers installed by `bun install`.
#
# This script is also directly invocable from PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\native\build-windows.ps1 -Platform x64
#

[CmdletBinding()]
param(
    [ValidateSet("x64", "arm64")]
    [string]$Platform = "x64",

    [ValidateSet("Release", "Debug")]
    [string]$Configuration = "Release",

    [switch]$AllPlatforms
)

$ErrorActionPreference = "Stop"

# Find MSBuild via vswhere.exe (ships with VS Build Tools).
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) {
    throw "vswhere.exe not found. Install Visual Studio 2022 Build Tools with the C++ workload."
}

$vsPath = & $vswhere -latest -products * -requires Microsoft.Component.MSbuild -property installationPath
if (-not $vsPath) {
    throw "No Visual Studio installation found that includes MSBuild."
}

$msbuild = Join-Path $vsPath "MSBuild\Current\Bin\MSBuild.exe"
if (-not (Test-Path $msbuild)) {
    $msbuild = Join-Path $vsPath "MSBuild\15.0\Bin\MSBuild.exe"
}
if (-not (Test-Path $msbuild)) {
    throw "MSBuild.exe not found at $msbuild"
}

Push-Location $PSScriptRoot
try {
    $solutionDir = "$PSScriptRoot\"

    # Detect available toolset
    $toolset = "v143"
    $foundDirs = @(Get-ChildItem -Path (Join-Path $vsPath "MSBuild\Microsoft\VC\*\Platforms\x64\PlatformToolsets\*") -Directory -ErrorAction SilentlyContinue)
    $names = @($foundDirs | ForEach-Object { $_.Name })
    if ("v143" -in $names) {
        $toolset = "v143"
    } elseif ($names.Count -gt 0) {
        $toolset = $names[-1]
    }
    Write-Host "Using Toolset: $toolset" -ForegroundColor Cyan

    # Build one or both platforms.
    if ($AllPlatforms) {
        Write-Host "Building haril_native for both platforms: x64 and arm64" -ForegroundColor Cyan
        foreach ($plat in @("x64", "arm64")) {
            Write-Host "Building haril_native for $plat / $Configuration" -ForegroundColor Cyan
            & $msbuild /m /v:minimal /p:Configuration=$Configuration /p:Platform=$plat /p:PlatformToolset=$toolset /p:SolutionDir=$solutionDir haril_native.vcxproj
            if ($LASTEXITCODE -ne 0) {
                throw "MSBuild failed for ${plat}: exit ${LASTEXITCODE}"
            }
        }
    }
    else {
        # Build the requested single platform (backward-compatible).
        Write-Host "Building haril_native for $Platform / $Configuration" -ForegroundColor Cyan
        & $msbuild /m /v:minimal /p:Configuration=$Configuration /p:Platform=$Platform /p:PlatformToolset=$toolset /p:SolutionDir=$solutionDir haril_native.vcxproj
        if ($LASTEXITCODE -ne 0) {
            throw "MSBuild failed: exit ${LASTEXITCODE}"
        }
    }
}
finally {
    Pop-Location
}

# Mirror the built DLL as .node for Node.js / Bun consumption.
# We always mirror the x64 build to `out\bin\haril_native.node` (the default),
# and also mirror arm64 to `out\bin-arm64\haril_native.node` if that platform was built.
$outSubDirs = @()
if ($Platform -eq "arm64" -or $AllPlatforms) {
    $outSubDirs += "bin-arm64"
}
if ($Platform -eq "x64" -or $AllPlatforms) {
    $outSubDirs += "bin"
}

foreach ($subDir in $outSubDirs) {
    # Use absolute path based on script location
    $scriptDir = $PSScriptRoot
    $dllPath = Join-Path -Path $scriptDir -ChildPath "out\$subDir\haril_native.dll"
    if (Test-Path $dllPath) {
        $size = (Get-Item $dllPath).Length
        Write-Host "OK: $dllPath ($size bytes)" -ForegroundColor Green
        # Mirror as .node for Node.js / Bun dlopen().
        $nodeMirror = Join-Path -Path $PSScriptRoot -ChildPath "out\$subDir\haril_native.node"
        if (-not (Test-Path $nodeMirror) -or
            (Get-Item $dllPath).LastWriteTime -gt (Get-Item $nodeMirror -ErrorAction SilentlyContinue).LastWriteTime) {
            Copy-Item -Force $dllPath $nodeMirror
        }
    }
    else {
        throw "DLL not found at $dllPath"
    }
}

Write-Host "Build complete." -ForegroundColor Cyan
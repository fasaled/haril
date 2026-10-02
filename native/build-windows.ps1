# Builds haril_native.node using MSBuild + MSVC.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File native/build-windows.ps1 -Platform x64
#   powershell -ExecutionPolicy Bypass -File native/build-windows.ps1 -Platform arm64
#
# Requires:
#   - Visual Studio 2022 Build Tools (or any VS with the C++ workload).
#   - Windows 10/11 SDK installed.
#   - node.lib from the matching Node.js distribution in native/.

param(
    [ValidateSet("x64", "arm64")]
    [string]$Platform = "x64",

    [ValidateSet("Release", "Debug")]
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"

# Find MSBuild via vswhere.exe (ships with VS Build Tools).
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) {
    Write-Error "vswhere.exe not found. Install Visual Studio 2022 Build Tools with the C++ workload."
}

$vsPath = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -property installationPath
if (-not $vsPath) {
    Write-Error "No Visual Studio installation found that includes MSBuild."
}

$msbuild = Join-Path $vsPath "MSBuild\Current\Bin\MSBuild.exe"
if (-not (Test-Path $msbuild)) {
    $msbuild = Join-Path $vsPath "MSBuild\15.0\Bin\MSBuild.exe"
}
if (-not (Test-Path $msbuild)) {
    Write-Error "MSBuild.exe not found at $msbuild"
}

# No node.lib needed: N-API entry points are resolved dynamically from
# the host process (node.exe or bun.exe) at load time via napi_dyn.cpp.

Write-Host "Using MSBuild: $msbuild" -ForegroundColor Cyan
Write-Host "Building haril_native for $Platform/$Configuration" -ForegroundColor Cyan

Push-Location -LiteralPath $PSScriptRoot
try {
    & $msbuild /m /v:minimal /p:Configuration=$Configuration /p:Platform=$Platform haril_native.vcxproj
    if ($LASTEXITCODE -ne 0) { throw "MSBuild failed: exit $LASTEXITCODE" }
}
finally {
    Pop-Location
}

$outSubDir = if ($Platform -eq "arm64") { "bin-arm64" } else { "bin" }
$dllPath = Join-Path -Path $PSScriptRoot -ChildPath "out\$outSubDir\haril_native.dll"
if (Test-Path $dllPath) {
    $size = (Get-Item $dllPath).Length
    Write-Host "OK: $dllPath ($size bytes)" -ForegroundColor Green
    # Mirror as .node for Node.js / Bun dlopen().
    $nodeMirror = Join-Path -Path $PSScriptRoot -ChildPath "out\$outSubDir\haril_native.node"
    if (-not (Test-Path $nodeMirror) -or
        (Get-Item $dllPath).LastWriteTime -gt (Get-Item $nodeMirror -ErrorAction SilentlyContinue).LastWriteTime) {
        Copy-Item -Force $dllPath $nodeMirror
    }
}
else {
    Write-Error "DLL not found at $dllPath"
}
param(
    [string]$Python = "python",
    [switch]$SkipInstall,
    [switch]$OneFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Resolve a fixed project root so double-click and terminal builds behave alike.
$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$EntryFile = Join-Path $ProjectRoot "main.py"
$RequirementsFile = Join-Path $ProjectRoot "requirements-dev.txt"

if (-not (Test-Path -LiteralPath $EntryFile -PathType Leaf)) {
    throw "GUI entry file was not found: $EntryFile"
}

function Invoke-PythonCommand {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

    & $Python @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Python command failed with exit code $LASTEXITCODE"
    }
}

Push-Location $ProjectRoot
try {
    if (-not $SkipInstall) {
        Write-Host "Installing build dependencies..." -ForegroundColor Cyan
        Invoke-PythonCommand -m pip install --upgrade pip
        Invoke-PythonCommand -m pip install -r $RequirementsFile
    }

    # Onedir starts faster; pass -OneFile when a single executable is required.
    $BundleMode = if ($OneFile) { "--onefile" } else { "--onedir" }
    $Arguments = @(
        "-m", "PyInstaller",
        "--noconfirm",
        "--clean",
        $BundleMode,
        "--windowed",
        "--name", "PhotoTakeoutStudio",
        "--paths", $ProjectRoot,
        "--collect-all", "customtkinter",
        "--collect-submodules", "PIL",
        $EntryFile
    )

    Write-Host "Building the Windows GUI..." -ForegroundColor Cyan
    Invoke-PythonCommand @Arguments

    if ($OneFile) {
        $Result = Join-Path $ProjectRoot "dist\PhotoTakeoutStudio.exe"
    }
    else {
        $Result = Join-Path $ProjectRoot "dist\PhotoTakeoutStudio\PhotoTakeoutStudio.exe"
    }
    Write-Host "Build completed: $Result" -ForegroundColor Green
}
finally {
    Pop-Location
}

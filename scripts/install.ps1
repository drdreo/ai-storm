# ai-storm installer for Windows (issue #216).
#
#   irm https://raw.githubusercontent.com/drdreo/ai-storm/main/scripts/install.ps1 | iex
#
# What it does:
#   1. Verifies git, Node >= 22.18 and pnpm (enabling pnpm via corepack when possible)
#   2. Clones (or updates) the repo into %LOCALAPPDATA%\ai-storm\app
#   3. Installs dependencies and builds the client bundle
#   4. Puts an `ai-storm` shim on your user PATH (%LOCALAPPDATA%\ai-storm\bin)
#
# Overridable via environment:
#   AI_STORM_HOME    install root         (default: %LOCALAPPDATA%\ai-storm)
#   AI_STORM_REPO    git URL to clone     (default: https://github.com/drdreo/ai-storm.git)
#   AI_STORM_BRANCH  branch to check out  (default: main)

$ErrorActionPreference = "Stop"

$MinNodeMajor = 22
$MinNodeMinor = 18

$Home_ = if ($env:AI_STORM_HOME) { $env:AI_STORM_HOME } else { Join-Path $env:LOCALAPPDATA "ai-storm" }
$Repo = if ($env:AI_STORM_REPO) { $env:AI_STORM_REPO } else { "https://github.com/drdreo/ai-storm.git" }
$Branch = if ($env:AI_STORM_BRANCH) { $env:AI_STORM_BRANCH } else { "main" }
$AppDir = Join-Path $Home_ "app"
$BinDir = Join-Path $Home_ "bin"

function Say([string]$msg) { Write-Host "[ai-storm] $msg" }
function Die([string]$msg) { Write-Error "[ai-storm] $msg"; exit 1 }

# --- 1. prerequisites --------------------------------------------------------

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Die "git is required. Install it from https://git-scm.com and re-run."
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Die "Node.js >= $MinNodeMajor.$MinNodeMinor is required (24 LTS recommended): https://nodejs.org"
}
$nodeVersion = (node -v) -replace "^v", ""
$parts = $nodeVersion.Split(".")
$major = [int]$parts[0]; $minor = [int]$parts[1]
if ($major -lt $MinNodeMajor -or ($major -eq $MinNodeMajor -and $minor -lt $MinNodeMinor)) {
    Die "Node v$nodeVersion is too old - ai-storm needs >= $MinNodeMajor.$MinNodeMinor (24 LTS recommended): https://nodejs.org"
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    if (Get-Command corepack -ErrorAction SilentlyContinue) {
        Say "pnpm not found - enabling it via corepack..."
        corepack enable pnpm 2>$null
    }
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Die "pnpm is required: https://pnpm.io/installation (or: corepack enable pnpm)"
}

# --- 2. clone or update ------------------------------------------------------

if (Test-Path (Join-Path $AppDir ".git")) {
    Say "Updating existing install in $AppDir..."
    git -C $AppDir fetch origin $Branch
    git -C $AppDir checkout $Branch 2>$null
    git -C $AppDir pull --ff-only origin $Branch
} else {
    Say "Cloning $Repo ($Branch) into $AppDir..."
    New-Item -ItemType Directory -Force -Path $Home_ | Out-Null
    git clone --branch $Branch --depth 1 $Repo $AppDir
}
if ($LASTEXITCODE -ne 0) { Die "git failed - see the output above." }

# --- 3. install + build ------------------------------------------------------

Say "Installing dependencies..."
Push-Location $AppDir
try {
    pnpm install
    if ($LASTEXITCODE -ne 0) { Die "pnpm install failed." }
    Say "Building the client bundle..."
    pnpm build
    if ($LASTEXITCODE -ne 0) { Die "pnpm build failed." }
} finally {
    Pop-Location
}

# --- 4. shim on PATH ---------------------------------------------------------

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$cliEntry = Join-Path $AppDir "packages\cli\bin\ai-storm.ts"
$shim = Join-Path $BinDir "ai-storm.cmd"
Set-Content -Path $shim -Value "@echo off`r`nnode `"$cliEntry`" %*" -Encoding ascii
Say "Installed the ai-storm command at $shim"

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$BinDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$BinDir;$userPath", "User")
    Say "Added $BinDir to your user PATH - open a NEW terminal for it to take effect."
}

Say "Done! Check your setup with:  ai-storm doctor"
Say "Then start the app with:      ai-storm"

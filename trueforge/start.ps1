# Starts the pinned TrueForge in local (standalone) mode for Swage on Windows.
# Same settings as start.sh: pinned version, SQLite outside the repository, loopback allowlisted.
$ErrorActionPreference = 'Stop'

# Keep in sync with src/supervisor/pin.ts (a unit test checks this).
$TrueForgeVersion = '0.184.2'

if (-not $env:PORT) { $env:PORT = '8790' }
if (-not $env:SQLITE_PATH) { $env:SQLITE_PATH = Join-Path $HOME 'trueforge-data\trueforge.sqlite' }
if (-not $env:HOST) { $env:HOST = '127.0.0.1' }
$env:OUTBOUND_URL_ALLOWED_HOSTS = '["127.0.0.1","localhost"]'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$DataDir = Split-Path -Parent $env:SQLITE_PATH
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$DataDir = (Resolve-Path $DataDir).Path
if ($DataDir.StartsWith($RepoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "SQLITE_PATH must be outside the Swage repository (got $env:SQLITE_PATH)."
}

Set-Location $DataDir
Write-Host "Starting TrueForge $TrueForgeVersion on http://$($env:HOST):$($env:PORT) (database: $env:SQLITE_PATH)"
npx --yes "@truefoundry/trueforge@$TrueForgeVersion" --port $env:PORT

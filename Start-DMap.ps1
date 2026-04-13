param(
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

npm run doctor

if (-not $SkipBuild) {
  npm run build
}

npm run start

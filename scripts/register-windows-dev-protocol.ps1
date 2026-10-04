param(
  [switch]$Unregister
)

$protocol = "echo-dev"
$protocolKey = "HKCU:\Software\Classes\$protocol"

if ($Unregister) {
  if (Test-Path $protocolKey) {
    Remove-Item -LiteralPath $protocolKey -Recurse -Force
  }
  exit 0
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$devExecutable = Join-Path $repoRoot "src-tauri\target\debug\echo.exe"
$commandKey = Join-Path $protocolKey "shell\open\command"

New-Item -Path $commandKey -Force | Out-Null
Set-ItemProperty -LiteralPath $protocolKey -Name "(Default)" -Value "URL:Echo Development Protocol"
Set-ItemProperty -LiteralPath $protocolKey -Name "URL Protocol" -Value ""
Set-ItemProperty -LiteralPath $commandKey -Name "(Default)" -Value ('"{0}" "%1"' -f $devExecutable)

Write-Output "Registered ${protocol}:// for $devExecutable"

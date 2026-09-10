# kawaii-stack uninstaller. Leaves C:\kawaii-stack and logs in place;
# removes the scheduled task and PATH entry, stops all services.

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host 'Stopping all services via the daemon (if running)...'
& "$root\bin\stack.cmd" shutdown

Unregister-ScheduledTask -TaskName 'KawaiiStack' -Confirm:$false
Write-Host "[ok] scheduled task 'KawaiiStack' removed"

$binDir = "$root\bin"
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -like "*$binDir*") {
  $newPath = ($userPath -split ';' | Where-Object { $_ -and $_ -ne $binDir }) -join ';'
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  Write-Host '[ok] PATH entry removed'
}

Write-Host ''
Write-Host "Done. Files and logs left at $root - delete the folder to remove completely."
Write-Host "Note: the old 'Cloudflared' Windows service remains disabled. To re-enable it:"
Write-Host '  Set-Service Cloudflared -StartupType Automatic; Start-Service Cloudflared'

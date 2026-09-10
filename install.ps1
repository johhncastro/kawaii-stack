# kawaii-stack installer - run from an ADMIN PowerShell:
#   powershell -ExecutionPolicy Bypass -File C:\kawaii-stack\install.ps1
#
# Every consequential step asks first. Safe to re-run.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = 'C:\Program Files\nodejs\node.exe'

function Ask($q) { $a = Read-Host "$q [y/N]"; return $a -match '^[yY]' }

Write-Host ''
Write-Host '== kawaii-stack installer ==' -ForegroundColor Cyan

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host 'Please run from an elevated (Administrator) PowerShell.' -ForegroundColor Red; exit 1 }

# ---- 1. preflight -----------------------------------------------------------
if (-not (Test-Path $node)) { Write-Host "node.exe not found at $node" -ForegroundColor Red; exit 1 }
if (-not (Test-Path 'C:\cloudflared.exe')) { Write-Host 'C:\cloudflared.exe not found' -ForegroundColor Red; exit 1 }
if (-not (Test-Path "$root\services.json")) {
  Copy-Item "$root\services.example.json" "$root\services.json"
  Write-Host ''
  Write-Host 'No services.json found - created one from services.example.json.' -ForegroundColor Yellow
  Write-Host "Edit $root\services.json to match this machine (paths, ports, tunnel config), then re-run the installer."
  exit 1
}
$cfgJson = Get-Content "$root\services.json" -Raw | ConvertFrom-Json
foreach ($s in $cfgJson.services) {
  if (-not (Test-Path $s.cwd)) { Write-Host "missing service directory: $($s.cwd) (service $($s.id))" -ForegroundColor Red; exit 1 }
}
New-Item -ItemType Directory -Force "$root\logs" | Out-Null
New-Item -ItemType Directory -Force "$root\run"  | Out-Null
Write-Host '[ok] preflight passed (node, cloudflared, all service dirs present)'

# ---- 2. clean up the broken old autostart mechanisms ------------------------
$cfSvc = Get-Service Cloudflared -ErrorAction SilentlyContinue
if ($cfSvc -and $cfSvc.StartType -ne 'Disabled') {
  Write-Host ''
  Write-Host "Found Windows service 'Cloudflared' (it has no config and serves nothing,"
  Write-Host 'but auto-starts at boot; kawaii-stack will own the tunnel instead).'
  if (Ask "Stop + disable the 'Cloudflared' service? (reversible: Set-Service Cloudflared -StartupType Automatic)") {
    try { Stop-Service Cloudflared -Force -ErrorAction Stop } catch {}
    Set-Service Cloudflared -StartupType Disabled
    Write-Host '[ok] Cloudflared service stopped and disabled'
  } else { Write-Host '[skip] Cloudflared service left as-is (it will double-connect the tunnel at boot)' -ForegroundColor Yellow }
}
$oldTask = Get-ScheduledTask -TaskName 'Start Kawaii Production' -ErrorAction SilentlyContinue
if ($oldTask) {
  Write-Host ''
  Write-Host "Found broken scheduled task 'Start Kawaii Production' (can never fire, and its script kills ALL node processes)."
  if (Ask 'Delete it?') {
    Unregister-ScheduledTask -TaskName 'Start Kawaii Production' -Confirm:$false
    Write-Host '[ok] old task deleted'
  }
}

# ---- 3. currently-running hand-launched processes ---------------------------
$daemonPid = $null
if (Test-Path "$root\run\daemon.pid") { $daemonPid = [int](Get-Content "$root\run\daemon.pid") }
$daemonProc = $null
if ($daemonPid) { $daemonProc = Get-Process -Id $daemonPid -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'node' } }

# PIDs the daemon itself owns (never offer to kill those)
$ownPids = @()
if ($daemonProc) {
  $ownPids += $daemonPid
  if (Test-Path "$root\run\children.json") {
    $kids = Get-Content "$root\run\children.json" -Raw | ConvertFrom-Json
    $kids.PSObject.Properties | ForEach-Object { $ownPids += [int]$_.Value }
  }
}
if ($daemonProc) {
  Write-Host ''
  Write-Host "[ok] kawaii-stack daemon already running (pid $daemonPid) - looking only for FOREIGN leftovers"
}
if ($true) {
  $found = @()
  Get-Process cloudflared -ErrorAction SilentlyContinue | ForEach-Object {
    $found += [pscustomobject]@{ What = 'cloudflared (tunnel)'; ProcId = $_.Id }
  }
  foreach ($port in 3000, 3001, 3005, 3006) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -First 1 | ForEach-Object {
        $found += [pscustomobject]@{ What = "web app on port $port"; ProcId = $_.OwningProcess }
      }
  }
  # popbot runs as plain `node dist/index.js`; its own daemon spawn uses the full
  # C:\project\popbot\dist\index.js path, so this only matches the hand-launched one
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'dist[\\/]index\.js' -and $_.CommandLine -notmatch 'popbot' } | ForEach-Object {
      $found += [pscustomobject]@{ What = 'popbot (discord bot)'; ProcId = $_.ProcessId }
    }
  $found = @($found | Where-Object { $ownPids -notcontains [int]$_.ProcId })
  if ($found.Count -gt 0) {
    Write-Host ''
    Write-Host 'Hand-launched (non-daemon) processes currently running:' -ForegroundColor Yellow
    $found | Format-Table -AutoSize | Out-Host
    Write-Host 'Recommended: stop them so the daemon owns everything (a tunnel or bot duplicate is actively harmful;'
    Write-Host "web apps left running just show as 'external' in the dashboard until they die)."
    if (Ask 'Stop ALL of the above (by exact PID) now?') {
      $found | Select-Object -ExpandProperty ProcId -Unique | ForEach-Object {
        Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
      }
      Write-Host '[ok] stopped'
      if ($daemonProc) {
        Start-Sleep -Seconds 2
        # nudge any service the daemon had marked external now that its port is free
        & "$root\bin\stack.cmd" status | Select-String 'external' | ForEach-Object {
          $svcName = ($_ -split '\s+')[0]
          $svcId = ($cfgJson.services | Where-Object { $_.name -eq $svcName -or $_.id -eq $svcName }).id
          if ($svcId) { Write-Host "restarting $svcId (port now free)"; & "$root\bin\stack.cmd" restart $svcId }
        }
      }
    } else {
      Write-Host '[skip] left running' -ForegroundColor Yellow
    }
  } else {
    Write-Host '[ok] no foreign hand-launched processes found'
  }
}

# ---- 4. the boot Scheduled Task ---------------------------------------------
Write-Host ''
$existing = Get-ScheduledTask -TaskName 'KawaiiStack' -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Scheduled task 'KawaiiStack' already exists - re-registering."
  Unregister-ScheduledTask -TaskName 'KawaiiStack' -Confirm:$false
}
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$root\src\daemon.js`"" -WorkingDirectory $root
$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
  -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Write-Host 'Boot task options:'
Write-Host '  RECOMMENDED: run at BOOT with no login needed. Windows requires your account password once to store the task.'
if (Ask 'Register to run at boot, no login needed?') {
  $user = "$env:COMPUTERNAME\$env:USERNAME"
  $pw = Read-Host "Windows password for $user" -AsSecureString
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw))
  $trigger = New-ScheduledTaskTrigger -AtStartup
  Register-ScheduledTask -TaskName 'KawaiiStack' -Action $action -Trigger $trigger -Settings $settings `
    -User $user -Password $plain -RunLevel Limited | Out-Null
  $plain = $null
  Write-Host '[ok] boot task registered - the stack starts at power-on even with nobody logged in'
} else {
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
  Register-ScheduledTask -TaskName 'KawaiiStack' -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal | Out-Null
  Write-Host '[ok] logon task registered - the stack starts when you log in (NOT before)'
}
Write-Host 'NOTE: never use Task Scheduler "End" on this task (it kills every service with it).' -ForegroundColor Yellow
Write-Host '      To stop everything cleanly use: stack shutdown'

# ---- 5. `stack` on PATH -----------------------------------------------------
$binDir = "$root\bin"
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -eq $userPath) { $userPath = '' }
if ($userPath -notlike "*$binDir*") {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $binDir).TrimStart(';'), 'User')
  Write-Host "[ok] added $binDir to your user PATH (takes effect in NEW terminals)"
} else {
  Write-Host '[ok] stack already on PATH'
}

# ---- 6. start now? ----------------------------------------------------------
Write-Host ''
if (-not $daemonProc) {
  if (Ask 'Start the daemon now (via the scheduled task)?') {
    Start-ScheduledTask -TaskName 'KawaiiStack'
    Start-Sleep -Seconds 5
    & "$binDir\stack.cmd" status
  }
}

Write-Host ''
Write-Host '== done ==' -ForegroundColor Cyan
Write-Host 'Quickstart (in a NEW terminal):'
Write-Host '  stack            live dashboard'
Write-Host '  stack status     one-shot status'
Write-Host '  stack logs kawaii -f'
Write-Host '  stack build kawaii'
Write-Host '  stack shutdown   stop everything cleanly'

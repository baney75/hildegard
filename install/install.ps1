# SPDX-License-Identifier: AGPL-3.0-only
#
# Installs Hildegard @VERSION@ for this Windows user: no admin rights, nothing outside %LOCALAPPDATA%\Hildegard.
#
#   irm https://github.com/baney75/hildegard/releases/download/v@VERSION@/install.ps1 | iex
#
# What it does, in order:
#   1. Downloads Node.js @NODE@ from nodejs.org and Hildegard @VERSION@ from GitHub, and checks each against the
#      SHA-256 written into this script. A file that doesn't match is refused and nothing is installed.
#   2. Puts them in %LOCALAPPDATA%\Hildegard, and a `hildegard` command in %LOCALAPPDATA%\Hildegard\bin, which it adds
#      to your user PATH.
#   3. Runs `hildegard install --yes`, which sets up ComfyUI and PyTorch for your GPU, then starts Hildegard.
#
# Set HILDEGARD_HOME to install somewhere else, HILDEGARD_SKIP_SETUP=1 to stop after step 2, or
# HILDEGARD_INSTALL_ARGS (for example "--json") to pass options to step 3.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# When an older Hildegard runs this to update itself, its own paths are in the environment. They name the version being
# replaced, and the new one must find its files where it is, so drop them; hildegard.cmd sets what it needs.
foreach ($v in 'HILDEGARD_ENTRY', 'HILDEGARD_RESOURCES', 'HILDEGARD_PRESETS_DIR', 'HILDEGARD_COMMIT') {
  Remove-Item "Env:$v" -ErrorAction SilentlyContinue
}

$Version = '@VERSION@'
$Node = '@NODE@'
$Release = if ($env:HILDEGARD_RELEASE_URL) { $env:HILDEGARD_RELEASE_URL } else { "https://github.com/baney75/hildegard/releases/download/v$Version" }
# Where Node.js comes from. Each file is still checked against the SHA-256 written below, wherever it comes from.
$NodeDist = if ($env:HILDEGARD_NODE_URL) { $env:HILDEGARD_NODE_URL } else { 'https://nodejs.org/dist' }
$Arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$AppSha = @{ 'x64' = '@APP_SHA_win32_x64@'; 'arm64' = '@APP_SHA_win32_arm64@' }
$NodeSha = @{ 'x64' = '@NODE_SHA_win32_x64@'; 'arm64' = '@NODE_SHA_win32_arm64@' }

$Root = if ($env:HILDEGARD_HOME) { $env:HILDEGARD_HOME } else { Join-Path $env:LOCALAPPDATA 'Hildegard' }
$Bin = Join-Path $Root 'bin'

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("hildegard-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $Root, $Bin, $Tmp | Out-Null

function Get-Checked([string]$Url, [string]$Path, [string]$Sha) {
  Invoke-WebRequest -Uri $Url -OutFile $Path -UseBasicParsing
  $got = (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLower()
  if ($got -ne $Sha) {
    Remove-Item -Force $Path
    throw "$(Split-Path -Leaf $Path) didn't match its checksum (expected $Sha, got $got). Nothing was installed."
  }
}

# Runs a hildegard command for its effect only. Under 'Stop', a native command's stderr can throw in Windows
# PowerShell 5.1, which would skip what comes after it, so errors here are only reported through the exit code.
function Invoke-Quiet([string]$Launcher, [string]$Command) {
  if (-not (Test-Path $Launcher)) { return $false }
  $was = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Launcher $Command *> $null; return ($LASTEXITCODE -eq 0) }
  catch { return $false }
  finally { $ErrorActionPreference = $was }
}

# Removes `app`, whether it is a junction (only the link goes) or a copy (the folder goes, once nothing holds it).
function Remove-App([string]$Link) {
  if (-not (Test-Path $Link)) { return }
  $item = Get-Item $Link -Force
  if ($item.LinkType -eq 'Junction') { $item.Delete(); return }
  # The server closes its port a moment before its process lets go of the files.
  for ($i = 0; ; $i++) {
    try { Remove-Item -Recurse -Force $Link -ErrorAction Stop; return }
    catch { if ($i -ge 10) { throw "Couldn't replace $Link while something still uses it: $($_.Exception.Message)" }; Start-Sleep -Seconds 1 }
  }
}

# Points `app` at a version's folder: a junction (no admin rights needed), or a copy where the drive can't hold one
# (exFAT, FAT32).
function Set-App([string]$Link, [string]$Target) {
  try { New-Item -ItemType Junction -Path $Link -Target $Target -ErrorAction Stop | Out-Null }
  catch {
    if (Test-Path $Link) { Remove-Item -Recurse -Force $Link }
    Copy-Item -Recurse -Path $Target -Destination $Link
  }
}

$link = Join-Path $Root 'app'
$launcher = Join-Path $Bin 'hildegard.cmd'
$nodeDir = Join-Path $Root 'node'
$nodePrev = Join-Path $Root 'node.prev'
# The version this replaces, kept until setup finishes: its folder's name (app-<version>), and its Node.js in node.prev.
$prev = ''
$hadApp = Test-Path $link
$switched = $false
try {
  # ComfyUI, PyTorch for the GPU and Python take about 8 GB, and the first model about 20 GB more. Say so before
  # downloading anything, rather than failing halfway with a full disk.
  $NeedGB = if ($env:HILDEGARD_SKIP_SETUP -eq '1') { 1 } else { 12 }
  $Drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot([IO.Path]::GetFullPath($Root)))
  $FreeGB = [math]::Floor($Drive.AvailableFreeSpace / 1GB)
  if ($FreeGB -lt $NeedGB) {
    $other = Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Free -gt 40GB -and "$($_.Name):\" -ne $Drive.Name } |
      Sort-Object Free -Descending | Select-Object -First 1
    $hint = if ($other) { "$($other.Name):\Hildegard, which has $([math]::Floor($other.Free / 1GB)) GB free" } else { 'a drive with more room' }
    Write-Host "Hildegard needs at least $NeedGB GB free to install, plus about 20 GB for its first model, and $($Drive.Name) has $FreeGB GB."
    Write-Host "To install on $hint, run:"
    Write-Host ''
    $dir = if ($other) { "$($other.Name):\Hildegard" } else { 'D:\Hildegard' }
    Write-Host "  `$env:HILDEGARD_HOME = '$dir'; irm $Release/install.ps1 | iex"
    Write-Host ''
    # A throw, not exit: under `irm | iex`, exit would close the window.
    throw "Not enough free space on $($Drive.Name). Nothing was installed."
  }

  # Node.js, Hildegard's own copy, so it never depends on (or changes) one you have.
  $nodeExe = Join-Path $nodeDir 'node.exe'
  $have = if (Test-Path $nodeExe) { & $nodeExe --version } else { '' }
  if ($have -ne "v$Node") {
    Write-Host "Getting Node.js $Node..."
    $f = "node-v$Node-win-$Arch.zip"
    Get-Checked "$NodeDist/v$Node/$f" (Join-Path $Tmp $f) $NodeSha[$Arch]
    Expand-Archive -Path (Join-Path $Tmp $f) -DestinationPath $Tmp -Force
    if (Test-Path $nodePrev) { Remove-Item -Recurse -Force $nodePrev }
    if (Test-Path $nodeDir) { Move-Item $nodeDir $nodePrev }
    Move-Item (Join-Path $Tmp "node-v$Node-win-$Arch") $nodeDir
  }

  Write-Host "Getting Hildegard $Version..."
  $f = "hildegard-$Version-win32-$Arch.tar.gz"
  Get-Checked "$Release/$f" (Join-Path $Tmp $f) $AppSha[$Arch]
  $app = Join-Path $Root "app-$Version"
  if (Test-Path $app) { Remove-Item -Recurse -Force $app }
  New-Item -ItemType Directory -Force -Path $app | Out-Null
  & (Join-Path $env:SystemRoot 'System32\tar.exe') -xmzf (Join-Path $Tmp $f) -C $app --strip-components 1
  if ($LASTEXITCODE -ne 0) { throw "Couldn't unpack $f." }

  # `app` is a junction to the current version, so paths given to AI apps survive upgrades. Keep this version and the
  # one before it, for going back.
  if ($hadApp) {
    $old = Get-Item $link -Force
    if ($old.LinkType -eq 'Junction') {
      $prev = Split-Path -Leaf $old.Target
      if ($prev -eq "app-$Version") { $prev = '' }
      $switched = $true
      $old.Delete()
    }
    else {
      # A copy (on exFAT or FAT32) is in use while Hildegard runs from it, so stop Hildegard first; setup below starts
      # it again. The copy is kept as app-<its version>, for going back.
      Invoke-Quiet $launcher 'stop' | Out-Null
      $was = ''
      try { $was = (Get-Content -Raw (Join-Path $link 'package.json') | ConvertFrom-Json).version } catch { $was = '' }
      $switched = $true
      if ($was -and $was -ne $Version -and -not (Test-Path (Join-Path $Root "app-$was"))) {
        for ($i = 0; ; $i++) {
          try { Move-Item $link (Join-Path $Root "app-$was") -ErrorAction Stop; break }
          catch { if ($i -ge 10) { throw "Couldn't replace $link while something still uses it: $($_.Exception.Message)" }; Start-Sleep -Seconds 1 }
        }
        $prev = "app-$was"
      }
      else {
        if ($was -and $was -ne $Version) { $prev = "app-$was" }
        Remove-App $link
      }
    }
  }
  Set-App $link $app
  Get-ChildItem -Directory -Path $Root -Filter 'app-*' | Where-Object { $_.Name -ne "app-$Version" -and $_.Name -ne $prev } | Remove-Item -Recurse -Force

  Set-Content -Path $launcher -Encoding ASCII -Value @"
@echo off
set "HILDEGARD_HOME=$Root"
set "HILDEGARD_ENTRY=$link\hildegard.mjs"
"$Root\node\node.exe" "$link\hildegard.mjs" %*
"@
  Write-Host "Installed the hildegard command in $Bin."

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (($userPath -split ';') -contains $Bin)) {
    [Environment]::SetEnvironmentVariable('Path', ((@($userPath, $Bin) | Where-Object { $_ }) -join ';'), 'User')
    Write-Host "Added $Bin to your PATH. New terminals will find hildegard by name."
  }
  if (-not (($env:Path -split ';') -contains $Bin)) { $env:Path = "$env:Path;$Bin" }

  if ($env:HILDEGARD_SKIP_SETUP -ne '1') {
    $extra = if ($env:HILDEGARD_INSTALL_ARGS) { $env:HILDEGARD_INSTALL_ARGS -split '\s+' | Where-Object { $_ } } else { @() }
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $launcher install --yes @extra; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $eap }
    if ($code -ne 0) { throw "setting up $Version failed (exit $code)" }
  }
  if (Test-Path $nodePrev) { Remove-Item -Recurse -Force $nodePrev -ErrorAction SilentlyContinue }
}
catch {
  $why = $_.Exception.Message.TrimEnd('.')
  # Anything that failed puts back what was there, and starts it again: `hildegard update` stopped it to get here.
  if ($hadApp) {
    $back = if ($prev) { Join-Path $Root $prev } else { $null }
    Invoke-Quiet $launcher 'stop' | Out-Null
    if ($switched -and $back -and (Test-Path $back)) {
      Write-Host "Going back to Hildegard $($prev -replace '^app-', ''). Hildegard $Version stays in $(Join-Path $Root "app-$Version")."
      try { Remove-App $link; Set-App $link $back } catch { Write-Host "Couldn't put $link back: $($_.Exception.Message)" }
    }
    if (Test-Path $nodePrev) {
      try {
        if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }
        Move-Item $nodePrev $nodeDir
      }
      catch { Write-Host "Couldn't put Node.js back: $($_.Exception.Message)" }
    }
    $name = if ($prev) { "Hildegard $($prev -replace '^app-', '')" } elseif (-not $switched) { 'Hildegard' } else { $null }
    if ($name) {
      if (Invoke-Quiet $launcher 'start') { $why = "$why, so $name runs again. To try $Version again, run: hildegard install" }
      else { $why = "$why, and $name didn't start either. Run: hildegard doctor" }
    }
  }
  elseif (Test-Path $nodePrev) {
    Remove-Item -Recurse -Force $nodeDir -ErrorAction SilentlyContinue
    Move-Item $nodePrev $nodeDir -ErrorAction SilentlyContinue
  }
  # A throw, not exit: under `irm | iex`, exit would close the window.
  if ($why -notmatch 'hildegard (install|doctor)$') { $why = "$why." }
  throw "hildegard: $why"
}
finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}

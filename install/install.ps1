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

$Version = '@VERSION@'
$Node = '@NODE@'
$Release = if ($env:HILDEGARD_RELEASE_URL) { $env:HILDEGARD_RELEASE_URL } else { "https://github.com/baney75/hildegard/releases/download/v$Version" }
$Arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$AppSha = @{ 'x64' = '@APP_SHA_win32_x64@'; 'arm64' = '@APP_SHA_win32_arm64@' }
$NodeSha = @{ 'x64' = '@NODE_SHA_win32_x64@'; 'arm64' = '@NODE_SHA_win32_arm64@' }

$Root = if ($env:HILDEGARD_HOME) { $env:HILDEGARD_HOME } else { Join-Path $env:LOCALAPPDATA 'Hildegard' }
$Bin = Join-Path $Root 'bin'

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

try {
  # Node.js, Hildegard's own copy, so it never depends on (or changes) one you have.
  $nodeExe = Join-Path $Root 'node\node.exe'
  $have = if (Test-Path $nodeExe) { & $nodeExe --version } else { '' }
  if ($have -ne "v$Node") {
    Write-Host "Getting Node.js $Node..."
    $f = "node-v$Node-win-$Arch.zip"
    Get-Checked "https://nodejs.org/dist/v$Node/$f" (Join-Path $Tmp $f) $NodeSha[$Arch]
    Expand-Archive -Path (Join-Path $Tmp $f) -DestinationPath $Tmp -Force
    $dest = Join-Path $Root 'node'
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    Move-Item (Join-Path $Tmp "node-v$Node-win-$Arch") $dest
  }

  Write-Host "Getting Hildegard $Version..."
  $f = "hildegard-$Version-win32-$Arch.tar.gz"
  Get-Checked "$Release/$f" (Join-Path $Tmp $f) $AppSha[$Arch]
  $app = Join-Path $Root "app-$Version"
  if (Test-Path $app) { Remove-Item -Recurse -Force $app }
  New-Item -ItemType Directory -Force -Path $app | Out-Null
  & (Join-Path $env:SystemRoot 'System32\tar.exe') -xmzf (Join-Path $Tmp $f) -C $app --strip-components 1
  if ($LASTEXITCODE -ne 0) { throw "Couldn't unpack $f." }

  # `app` is a junction to the current version (no admin rights needed), so paths given to AI apps survive upgrades.
  # Keep this version and the one before it, for going back. exFAT and FAT32 drives can't hold a junction, so there
  # `app` is a copy of the current version instead.
  $link = Join-Path $Root 'app'
  $prev = ''
  if (Test-Path $link) {
    $old = Get-Item $link
    if ($old.LinkType -eq 'Junction') { $prev = Split-Path -Leaf $old.Target; $old.Delete() }
    else {
      # A copy (on exFAT or FAT32) is in use while Hildegard runs from it, so stop Hildegard first; setup below starts
      # it again.
      $old = Join-Path $Bin 'hildegard.cmd'
      if (Test-Path $old) { & $old stop *> $null }
      # The server closes its port a moment before its process lets go of the files.
      for ($i = 0; ; $i++) {
        try { Remove-Item -Recurse -Force $link -ErrorAction Stop; break }
        catch { if ($i -ge 10) { throw "Couldn't replace $link while something still uses it: $($_.Exception.Message)" }; Start-Sleep -Seconds 1 }
      }
    }
  }
  try { New-Item -ItemType Junction -Path $link -Target $app -ErrorAction Stop | Out-Null }
  catch {
    if (Test-Path $link) { Remove-Item -Recurse -Force $link }
    Copy-Item -Recurse -Path $app -Destination $link
  }
  Get-ChildItem -Directory -Path $Root -Filter 'app-*' | Where-Object { $_.Name -ne "app-$Version" -and $_.Name -ne $prev } | Remove-Item -Recurse -Force

  $launcher = Join-Path $Bin 'hildegard.cmd'
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
}
finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}

if ($env:HILDEGARD_SKIP_SETUP -ne '1') {
  $extra = if ($env:HILDEGARD_INSTALL_ARGS) { $env:HILDEGARD_INSTALL_ARGS -split '\s+' | Where-Object { $_ } } else { @() }
  & $launcher install --yes @extra
  # A throw, not exit: under `irm | iex`, exit would close the window.
  if ($LASTEXITCODE -ne 0) { throw "hildegard install didn't finish. Run it again with: hildegard install" }
}

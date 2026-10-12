#Requires -Version 5.1
<#
.SYNOPSIS
  Instala video-down en Windows para el usuario actual (sin permisos de administrador).

.DESCRIPTION
  1. Copia la extensión y el componente nativo a %LOCALAPPDATA%\video-down (si no están ya).
  2. Descarga Deno y ffmpeg en versiones fijadas y comprueba su huella SHA-256.
  3. Descarga la última versión estable de yt-dlp y la comprueba contra su SHA2-256SUMS.
  4. Escribe config.json, el lanzador video-down-host.cmd y el manifiesto del componente nativo.
  5. Registra el componente nativo para Chrome, Edge, Brave y Chromium (HKCU).
  6. Comprueba que todo responde y abre chrome://extensions y la carpeta de la extensión.

  Es idempotente: ejecutarlo otra vez actualiza yt-dlp y rehace la configuración.
  El instalador .exe (Inno Setup) lo ejecuta tras copiar los ficheros.

.PARAMETER AppDir
  Carpeta de instalación. Por defecto %LOCALAPPDATA%\video-down.

.PARAMETER SourceDir
  Carpeta que contiene extension\, native-host\ y versions.json. Por defecto, la de este script.

.PARAMETER NoLaunch
  No abre Chrome ni el Explorador al terminar (lo usa el instalador .exe, que pregunta antes).
#>
param(
  [string]$AppDir = (Join-Path $env:LOCALAPPDATA 'video-down'),
  [string]$SourceDir = $PSScriptRoot,
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
# La barra de progreso de Invoke-WebRequest hace las descargas diez veces más lentas en PowerShell 5.1.
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Step([string]$Message) {
  Write-Host ''
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Save-Text([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, $Utf8NoBom)
}

function Get-Download([string]$Url, [string]$Destination) {
  Write-Host "    $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -Headers @{ 'User-Agent' = 'video-down-installer' }
}

function Assert-Sha256([string]$File, [string]$Expected) {
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $File).Hash.ToLowerInvariant()
  if ($actual -ne $Expected.ToLowerInvariant()) {
    throw "La huella SHA-256 de $(Split-Path -Leaf $File) no coincide.`n  esperada: $Expected`n  obtenida: $actual`nDescarga cancelada por seguridad."
  }
  Write-Host "    SHA-256 correcta" -ForegroundColor DarkGreen
}

function Get-Versions {
  $file = Join-Path $SourceDir 'versions.json'
  if (-not (Test-Path -LiteralPath $file)) { $file = Join-Path $AppDir 'versions.json' }
  return (Get-Content -Raw -Encoding UTF8 -LiteralPath $file | ConvertFrom-Json)
}

function Read-Installed {
  $file = Join-Path $AppDir 'bin\installed.json'
  if (Test-Path -LiteralPath $file) { return (Get-Content -Raw -LiteralPath $file | ConvertFrom-Json) }
  return [pscustomobject]@{}
}

# Everything printed below also goes to logs\install.log, for troubleshooting after the window closes.
New-Item -ItemType Directory -Force -Path (Join-Path $AppDir 'logs') | Out-Null
try { Start-Transcript -Path (Join-Path $AppDir 'logs\install.log') -Force | Out-Null } catch { }

try {
  Write-Host "video-down: instalación en $AppDir" -ForegroundColor White
  $v = Get-Versions
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("video-down-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null

  # ------------------------------------------------------------ 1. ficheros
  Step 'Copiando la extensión y el componente nativo'
  foreach ($d in 'bin', 'state', 'tmp', 'logs', 'cache') {
    New-Item -ItemType Directory -Force -Path (Join-Path $AppDir $d) | Out-Null
  }
  $sameDir = (Resolve-Path -LiteralPath $SourceDir).Path.TrimEnd('\') -ieq (Resolve-Path -LiteralPath $AppDir).Path.TrimEnd('\')
  if (-not $sameDir) {
    foreach ($item in 'extension', 'native-host') {
      $target = Join-Path $AppDir $item
      if (Test-Path -LiteralPath $target) { Remove-Item -Recurse -Force -LiteralPath $target }
      Copy-Item -Recurse -Force -LiteralPath (Join-Path $SourceDir $item) -Destination $target
    }
    Copy-Item -Force -LiteralPath (Join-Path $SourceDir 'versions.json') -Destination (Join-Path $AppDir 'versions.json')
    foreach ($script in 'install.ps1', 'uninstall.ps1') {
      $src = Join-Path $SourceDir $script
      if (Test-Path -LiteralPath $src) { Copy-Item -Force -LiteralPath $src -Destination (Join-Path $AppDir $script) }
    }
  }
  Write-Host '    hecho'

  $bin = Join-Path $AppDir 'bin'
  $installed = Read-Installed

  # ------------------------------------------------------------ 2. Deno
  Step "Deno $($v.deno.version)"
  if ($installed.deno -eq $v.deno.version -and (Test-Path -LiteralPath (Join-Path $bin 'deno.exe'))) {
    Write-Host '    ya instalado'
  } else {
    $zip = Join-Path $tmp 'deno.zip'
    Get-Download $v.deno.windows.url $zip
    Assert-Sha256 $zip $v.deno.windows.sha256
    Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $tmp 'deno') -Force
    Copy-Item -Force -LiteralPath (Join-Path $tmp 'deno\deno.exe') -Destination (Join-Path $bin 'deno.exe')
    $installed | Add-Member -Force -NotePropertyName deno -NotePropertyValue $v.deno.version
  }

  # ------------------------------------------------------------ 3. ffmpeg
  Step "ffmpeg $($v.ffmpeg.version)"
  if ($installed.ffmpeg -eq $v.ffmpeg.version -and (Test-Path -LiteralPath (Join-Path $bin 'ffmpeg.exe'))) {
    Write-Host '    ya instalado'
  } else {
    $zip = Join-Path $tmp 'ffmpeg.zip'
    Get-Download $v.ffmpeg.windows.url $zip
    Assert-Sha256 $zip $v.ffmpeg.windows.sha256
    Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $tmp 'ffmpeg') -Force
    foreach ($exe in 'ffmpeg.exe', 'ffprobe.exe') {
      $found = Get-ChildItem -Recurse -LiteralPath (Join-Path $tmp 'ffmpeg') -Filter $exe | Select-Object -First 1
      if (-not $found) { throw "No se encontró $exe dentro del paquete de ffmpeg." }
      Copy-Item -Force -LiteralPath $found.FullName -Destination (Join-Path $bin $exe)
    }
    $installed | Add-Member -Force -NotePropertyName ffmpeg -NotePropertyValue $v.ffmpeg.version
  }

  # ------------------------------------------------------------ 4. yt-dlp
  Step 'yt-dlp (última versión estable)'
  $tag = $null
  try {
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest' -UseBasicParsing -Headers @{ 'User-Agent' = 'video-down-installer' }
    $tag = $release.tag_name
  } catch {
    Write-Host '    no se pudo consultar la API de GitHub; se usa el enlace «latest»' -ForegroundColor Yellow
  }
  $base = if ($tag) { "https://github.com/yt-dlp/yt-dlp/releases/download/$tag" } else { 'https://github.com/yt-dlp/yt-dlp/releases/latest/download' }
  $sums = Join-Path $tmp 'SHA2-256SUMS'
  $exe = Join-Path $tmp 'yt-dlp.exe'
  Get-Download "$base/SHA2-256SUMS" $sums
  Get-Download "$base/yt-dlp.exe" $exe
  $line = Get-Content -LiteralPath $sums | Where-Object { $_ -match '\s+yt-dlp\.exe$' } | Select-Object -First 1
  if (-not $line) { throw 'SHA2-256SUMS no contiene yt-dlp.exe.' }
  Assert-Sha256 $exe ($line -split '\s+')[0]
  Copy-Item -Force -LiteralPath $exe -Destination (Join-Path $bin 'yt-dlp.exe')
  $installed | Add-Member -Force -NotePropertyName ytdlp -NotePropertyValue ($(if ($tag) { $tag } else { 'latest' }))
  Save-Text (Join-Path $bin 'installed.json') ($installed | ConvertTo-Json)

  # ------------------------------------------------------------ 5. configuración
  Step 'Configuración'
  # Real Downloads folder (it can be moved to another drive). Read from the registry rather than
  # through the Shell COM object, which can block in sessions without a desktop.
  $downloads = $null
  try {
    $raw = (Get-ItemProperty -ErrorAction Stop -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders').'{374DE290-123F-4565-9164-39C4925E467B}'
    if ($raw) { $downloads = [Environment]::ExpandEnvironmentVariables($raw) }
  } catch { }
  if (-not $downloads -or -not (Test-Path -LiteralPath $downloads)) { $downloads = Join-Path $env:USERPROFILE 'Downloads' }
  Save-Text (Join-Path $AppDir 'config.json') ((@{ downloadDir = $downloads; version = $v.videodown } | ConvertTo-Json))
  Write-Host "    carpeta de descargas: $downloads"

  # Lanzador: Deno con permisos explícitos. %~dp0 = carpeta del propio .cmd, así que no depende de la ruta.
  $launcher = @'
@echo off
setlocal
set "APP=%~dp0"
set "APP=%APP:~0,-1%"
set "DENO_DIR=%APP%\deno-cache"
set "DENO_NO_UPDATE_CHECK=1"
"%APP%\bin\deno.exe" run --quiet --no-prompt --no-config --no-lock --no-remote --no-npm --allow-read="%APP%" --allow-write="%APP%\state,%APP%\tmp,%APP%\logs" --allow-run="%APP%\bin\yt-dlp.exe,C:\Windows\System32\taskkill.exe" "%APP%\native-host\src\host.ts" %*
'@
  $launcherPath = Join-Path $AppDir 'video-down-host.cmd'
  [System.IO.File]::WriteAllText($launcherPath, ($launcher -replace "`r?`n", "`r`n"), (New-Object System.Text.ASCIIEncoding))

  $manifestPath = Join-Path $AppDir 'native-host-manifest.json'
  $manifest = [ordered]@{
    name            = $v.hostName
    description     = 'video-down native component (yt-dlp)'
    path            = $launcherPath
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$($v.extensionId)/")
  }
  Save-Text $manifestPath ($manifest | ConvertTo-Json)

  # ------------------------------------------------------------ 6. registro
  Step 'Registrando el componente nativo en el navegador'
  $keys = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
    'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts',
    'HKCU:\Software\Chromium\NativeMessagingHosts'
  )
  foreach ($k in $keys) {
    $key = Join-Path $k $v.hostName
    New-Item -Force -Path $key | Out-Null
    Set-ItemProperty -Path $key -Name '(default)' -Value $manifestPath
  }
  Write-Host '    hecho'

  # ------------------------------------------------------------ 7. comprobación
  Step 'Comprobando el componente nativo'
  $check = & cmd.exe /d /c "`"$launcherPath`" --self-check" 2>&1
  $checkExit = $LASTEXITCODE
  Write-Host "    $check"
  if ($checkExit -ne 0) { throw "La comprobación del componente nativo ha fallado (código $checkExit)." }

  Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue

  Write-Host ''
  Write-Host 'Componente nativo instalado.' -ForegroundColor Green
  Write-Host ''
  Write-Host 'Último paso, una sola vez (Chrome no permite que un programa lo haga por ti):' -ForegroundColor White
  Write-Host '  1. En chrome://extensions activa «Modo de desarrollador» (arriba a la derecha).'
  Write-Host '  2. Pulsa «Cargar descomprimida» y elige esta carpeta:'
  Write-Host "       $(Join-Path $AppDir 'extension')" -ForegroundColor Yellow
  Write-Host '  3. Abre las opciones de video-down y pulsa «Comprobar de nuevo».'

  if (-not $NoLaunch) {
    Start-Process explorer.exe -ArgumentList "`"$(Join-Path $AppDir 'extension')`""
    $chrome = $null
    foreach ($hive in 'HKCU', 'HKLM') {
      try { $chrome = (Get-ItemProperty -Path "${hive}:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" -ErrorAction Stop).'(default)' } catch { }
      if ($chrome) { break }
    }
    if ($chrome) { Start-Process -FilePath $chrome -ArgumentList 'chrome://extensions' }
  }
  try { Stop-Transcript | Out-Null } catch { }
  exit 0
} catch {
  Write-Host ''
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'No se ha completado la instalación. Revisa la conexión a Internet y vuelve a ejecutar el instalador.'
  Write-Host "Registro completo: $(Join-Path $AppDir 'logs\install.log')"
  try { Stop-Transcript | Out-Null } catch { }
  exit 1
}

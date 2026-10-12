#Requires -Version 5.1
<#
.SYNOPSIS
  Desinstala video-down del usuario actual: quita el registro del componente nativo y borra su carpeta.
  La extensión cargada en Chrome hay que quitarla a mano desde chrome://extensions.
  Las descargas ya hechas no se tocan.
#>
param(
  [string]$AppDir = (Join-Path $env:LOCALAPPDATA 'video-down'),
  [switch]$KeepFiles
)

$ErrorActionPreference = 'Continue'
$hostName = 'dev.marianogutierrez.videodown'

foreach ($k in @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
    'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts',
    'HKCU:\Software\Chromium\NativeMessagingHosts'
  )) {
  $key = Join-Path $k $hostName
  if (Test-Path $key) { Remove-Item -Recurse -Force -Path $key }
}
Write-Host 'Registro del componente nativo eliminado.'

if (-not $KeepFiles -and (Test-Path -LiteralPath $AppDir)) {
  # Sanity check: never delete anything that does not look like our own folder.
  if ((Split-Path -Leaf $AppDir) -ne 'video-down' -or -not (Test-Path -LiteralPath (Join-Path $AppDir 'native-host'))) {
    Write-Host "No se borra $AppDir porque no parece la carpeta de video-down." -ForegroundColor Yellow
    exit 1
  }
  Remove-Item -Recurse -Force -LiteralPath $AppDir
  Write-Host "Carpeta $AppDir eliminada."
}
Write-Host 'Quita también la extensión en chrome://extensions.'

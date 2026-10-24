[CmdletBinding()]
param(
  [ValidateSet('Chrome','Edge','Firefox')][string]$Browser = 'Chrome',
  [Parameter(Mandatory=$true)][string]$ExtensionId,
  [string]$HostPath = (Join-Path $PSScriptRoot 'native-host.exe')
)
$ErrorActionPreference = 'Stop'
$resolvedHost = (Resolve-Path -LiteralPath $HostPath).Path
if ($Browser -eq 'Firefox') {
  if ($ExtensionId -notmatch '^[A-Za-z0-9@._{}-]+$') { throw 'Invalid Firefox extension ID.' }
} elseif ($ExtensionId -notmatch '^[a-p]{32}$') { throw 'Chrome and Edge IDs must contain 32 letters a-p. Copy the ID from the extensions page.' }
$hostName = 'com.awesome.downloader'
$installDirectory = Join-Path $env:USERPROFILE '.awesome-downloader\NativeMessaging'
New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
$manifestPath = Join-Path $installDirectory "$hostName.$Browser.json"
$manifest = [ordered]@{ name=$hostName; description='Awesome Downloader browser bridge'; path=$resolvedHost; type='stdio' }
if ($Browser -eq 'Firefox') { $manifest.allowed_extensions = @($ExtensionId); $key = "HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName" }
elseif ($Browser -eq 'Edge') { $manifest.allowed_origins = @("chrome-extension://$ExtensionId/"); $key = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName" }
else { $manifest.allowed_origins = @("chrome-extension://$ExtensionId/"); $key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName" }
$newContent = $manifest | ConvertTo-Json -Depth 5
if (Test-Path -LiteralPath $manifestPath) {
  if ((Get-Content -LiteralPath $manifestPath -Raw).Trim() -ne $newContent.Trim()) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-ffff'
    Copy-Item -LiteralPath $manifestPath -Destination "$manifestPath.$stamp.bak"
  }
}
if (Test-Path -LiteralPath $key) {
  $oldPath = (Get-Item -LiteralPath $key).GetValue('')
  if ($oldPath -and $oldPath -ne $manifestPath) {
    $backup = @{registryKey=$key; previousDefault=$oldPath} | ConvertTo-Json
    $backup | Set-Content -LiteralPath (Join-Path $installDirectory "$Browser.registry-backup.$(Get-Date -Format 'yyyyMMdd-HHmmss-ffff').json") -Encoding utf8
  }
}
# UTF-8 without BOM is accepted by each browser.
[System.IO.File]::WriteAllText($manifestPath, $newContent, [System.Text.UTF8Encoding]::new($false))
New-Item -Path $key -Force | Out-Null
Set-Item -LiteralPath $key -Value $manifestPath
Write-Output "Registered $Browser bridge for $ExtensionId at $manifestPath"

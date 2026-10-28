[CmdletBinding()]
param(
  [ValidateSet('Chrome','Edge','Brave','Opera','Firefox')][string]$Browser = 'Chrome',
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
$manifestName = if ($Browser -eq 'Opera') { 'Chrome' } else { $Browser }
$manifestPath = Join-Path $installDirectory "$manifestName.json"
$manifest = [ordered]@{ name=$hostName; description='Awesome Downloader browser bridge'; path=$resolvedHost; type='stdio' }
if ($Browser -eq 'Firefox') { $manifest.allowed_extensions = @($ExtensionId); $key = "HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName" }
elseif ($Browser -eq 'Edge') { $manifest.allowed_origins = @("chrome-extension://$ExtensionId/"); $key = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName" }
elseif ($Browser -eq 'Brave') { $manifest.allowed_origins = @("chrome-extension://$ExtensionId/"); $key = "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$hostName" }
else { $manifest.allowed_origins = @("chrome-extension://$ExtensionId/"); $key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName" }
$priorContent = if (Test-Path -LiteralPath $manifestPath) { Get-Content -LiteralPath $manifestPath -Raw } else { $null }
if ($priorContent -and $Browser -ne 'Firefox') {
  try {
    $prior = $priorContent | ConvertFrom-Json
    $manifest.allowed_origins = @($prior.allowed_origins) + @($manifest.allowed_origins) | Where-Object { $_ -match '^chrome-extension://[a-p]{32}/$' } | Select-Object -Unique
  } catch { }
}
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

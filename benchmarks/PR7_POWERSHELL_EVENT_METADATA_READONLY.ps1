# ReviewForge: Windows-only READ-ONLY metadata, no keys, no process args.
# Time window centered on 2026-11-11 08:17 UTC (09:17 CET).
#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$start=([DateTime]::Parse('2026-11-11T07:55:00Z')).ToLocalTime()
$end=([DateTime]::Parse('2026-11-11T08:45:00Z')).ToLocalTime()
Write-Output 'READ_ONLY_WINDOWS_EVENTS_METADATA; NO EVENT MESSAGE CONTENT'
foreach($name in @('Windows PowerShell','Microsoft-Windows-PowerShell/Operational',
  'Microsoft-Windows-WER-SystemErrorReporting/Operational')){
  try{
    $log=Get-WinEvent -ListLog $name -ErrorAction Stop
    if(-not $log.IsEnabled){Write-Output ("Log not enabled: "+$name);continue}
    $events=@(Get-WinEvent -FilterHashtable @{
      LogName=$name;StartTime=$start;EndTime=$end
    } -MaxEvents 40 -ErrorAction Stop)
    $events | Select-Object TimeCreated,LogName,Id,ProviderName,LevelDisplayName
  }catch{ Write-Output ("No accessible event metadata for: "+$name) }
}
# WER folder names only, never the report contents (which can contain paths).
foreach($path in @(
  (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\WER\ReportArchive'),
  (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\WER\ReportQueue')
)){
  if(Test-Path -LiteralPath $path){
    Get-ChildItem -LiteralPath $path -Directory -ErrorAction SilentlyContinue |
      Where-Object {$_.Name -match '(node|powershell|pwsh)' -and
        $_.LastWriteTime -ge $start -and $_.LastWriteTime -le $end} |
      Select-Object Name,LastWriteTimeUtc
  }
}
Write-Output 'END_READ_ONLY_WINDOWS_EVENTS'

# Windows PR7 attempt investigation. READ ONLY. No API keys or prompts.
# Execute locally as the same Windows user as the attempted benchmark.
# Does not modify, unlock, reset, retry, test or call any provider.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$id='rf-pr7-independent-once-20261110-v2'
$root=Join-Path $env:USERPROFILE '.reviewforge\benchmark-journal'
$paths=@(
  (Join-Path $env:TEMP 'rf-heldout-pr7-paid-once-20261109.lock'),
  (Join-Path $root "$id.lock"),
  (Join-Path $root "$id.result.json"),
  (Join-Path $root "$id.result.json.usage.json"),
  (Join-Path $root "$id.result.json.dispatch.json")
)
Write-Output 'FILE METADATA ONLY (no file content):'
foreach($path in $paths){
  $f=Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
  [pscustomobject]@{
    Name=Split-Path $path -Leaf
    Exists=[bool]$f
    SizeBytes=if($f){$f.Length}else{$null}
    CreatedUtc=if($f){$f.CreationTimeUtc}else{$null}
    ModifiedUtc=if($f){$f.LastWriteTimeUtc}else{$null}
  }
}
Write-Output 'MATCHING NODE PROCESS IDS ONLY (no command line or key):'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object {$_.CommandLine -match 'pr7-one-paid\.mjs|__pr7_single_call_review\.mjs'} |
  Select-Object ProcessId,CreationDate
$lock=Get-Item -LiteralPath (Join-Path $root "$id.lock") -ErrorAction SilentlyContinue
if($lock){
  $start=$lock.CreationTime.AddMinutes(-10)
  $end=$lock.CreationTime.AddMinutes(20)
  Write-Output 'RELEVANT WINDOWS EVENT METADATA (no event messages):'
  foreach($spec in @(
    @{LogName='Application';Id=@(1000,1001,1026)},
    @{LogName='System';Id=@(41,6008,1074)}
  )){
    try{
      Get-WinEvent -FilterHashtable @{
        LogName=$spec.LogName;Id=$spec.Id;StartTime=$start;EndTime=$end
      } -MaxEvents 35 -ErrorAction Stop |
        Select-Object TimeCreated,LogName,Id,ProviderName,LevelDisplayName
    }catch{
      Write-Output ("No accessible matching events in "+$spec.LogName)
    }
  }
}else{
  Write-Output 'New lock absent in this Windows user profile; no timestamp basis.'
}

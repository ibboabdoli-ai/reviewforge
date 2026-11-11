# Mock-only PowerShell termination diagnostic.
# This NEVER invokes a paid AI call, reads credentials, or uses ReviewForge locks.
# Run only with a new isolated test directory whose name starts rf-shell-mock-.
#Requires -Version 5.1
param(
  [Parameter(Mandatory=$true)]
  [ValidateSet('node-ok','node-exit','node-stderr-exit','powershell-error','powershell-pause')]
  [string]$Scenario,
  [Parameter(Mandatory=$true)][string]$EvidenceDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$full=[System.IO.Path]::GetFullPath($EvidenceDirectory)
$leaf=Split-Path $full -Leaf
if($leaf -notmatch '^rf-shell-mock-[a-zA-Z0-9_-]{6,}$'){
  throw 'Only an isolated rf-shell-mock-* directory is permitted.'
}
if(Test-Path -LiteralPath $full) {throw 'Existing mock evidence directory refused.'}
New-Item -ItemType Directory -Path $full -ErrorAction Stop | Out-Null
$pre=Join-Path $full 'prelaunch.json'
$final=Join-Path $full 'terminal.json'
$utc=[DateTime]::UtcNow.ToString('o')
[System.IO.File]::WriteAllText($pre,(@{
  mode='OFFLINE_MOCK';scenario=$Scenario;stage='powershell_entered';
  atUtc=$utc;providerRequests=0
}|ConvertTo-Json -Compress))
$state='unknown'
$exitCode=$null
$exceptionType=$null
try{
  if($Scenario -eq 'powershell-pause'){
    Start-Sleep -Seconds 12
  }elseif($Scenario -eq 'powershell-error'){
    throw [System.InvalidOperationException]::new('Synthetic PowerShell terminating error')
  }else{
    # Fixed synthetic Node command; no network, keys, or arbitrary user script.
    $nodeProgram=@'
const mode=process.argv[1];
if(mode==='node-ok'){process.stdout.write('MOCK_NODE_OK\n');process.exit(0);}
if(mode==='node-stderr-exit'){process.stderr.write('MOCK_NODE_STDERR\n');process.exit(52);}
if(mode==='node-exit'){process.exit(51);}
process.exit(99);
'@
    & node -e $nodeProgram $Scenario
    $exitCode=$LASTEXITCODE
    if($exitCode -ne 0){throw [System.Exception]::new('Synthetic Node nonzero exit')}
  }
  $state='completed_mock_only'
}catch{
  $state='error_mock_only'
  $exceptionType=$_.Exception.GetType().Name
}finally{
  # This runs on ordinary Node exit or catchable PS exceptions.
  # It cannot run when the PowerShell process/terminal is forcibly killed.
  $record=@{
    mode='OFFLINE_MOCK';scenario=$Scenario;status=$state;
    nativeExitCode=$exitCode;exceptionType=$exceptionType;
    atUtc=[DateTime]::UtcNow.ToString('o');providerRequests=0
  }
  [System.IO.File]::WriteAllText($final,($record|ConvertTo-Json -Compress))
  Write-Output ('MOCK_TERMINAL_STATUS='+$state)
  Write-Output ('MOCK_EVIDENCE_PATH='+$final)
}
if($state -ne 'completed_mock_only'){exit 1}

# ReviewForge PR7 V3. Default is OFFLINE preflight. Paid needs new
# explicit owner approval, pinned engine SHA and a locally entered TEST key.
# Stage files never include commands, provider output, source or credentials.
#Requires -Version 5.1
param(
  [ValidateSet('Preflight','Paid','Mock')][string]$Mode='Preflight',
  [string]$SandboxCheckout='',
  [string]$ExpectedEngineSha='',
  [string]$ApprovalId='',
  [ValidateSet('node-ok','node-exit','node-timeout','powershell-error','shell-pause')]
  [string]$MockScenario='node-ok',
  [string]$MockEvidenceDirectory=''
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$id='rf-pr7-audited-once-20261111-v3'
$script:TracePath=$null
$script:TraceExists=$false
$script:Outcome='UNKNOWN'
$script:NodeExit=$null
function Emit-SafeStage([string]$Stage){
  $allowed=@('shell_started','mock_started','preflight_verified',
    'key_obtained','node_launching','node_returned_success',
    'node_returned_failure','shell_caught_exception',
    'shell_terminal_success','shell_terminal_failure')
  if($allowed -cnotcontains $Stage){throw 'INVALID_SAFE_STAGE'}
  if(-not $script:TracePath){throw 'NO_SAFE_TRACE_PATH'}
  $line=(@{schema=1;attempt=$id;stage=$Stage;
    utc=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json -Compress)+[Environment]::NewLine
  $mode=if($script:TraceExists){[IO.FileMode]::Append}else{[IO.FileMode]::CreateNew}
  $fs=[IO.FileStream]::new($script:TracePath,$mode,
    [IO.FileAccess]::Write,[IO.FileShare]::Read,4096,[IO.FileOptions]::WriteThrough)
  try{
    $bytes=[Text.Encoding]::UTF8.GetBytes($line)
    $fs.Write($bytes,0,$bytes.Length)
    $fs.Flush($true)
    $script:TraceExists=$true
  }finally{$fs.Dispose()}
}
function Check-Unused([string]$Folder){
  foreach($name in @(
    ($id+'.lock'),($id+'.result.json'),
    ($id+'.result.json.usage.json'),($id+'.result.json.dispatch.json'),
    ($id+'.node-stages.jsonl'),($id+'.shell-stages.jsonl')
  )){
    if(Test-Path -LiteralPath (Join-Path $Folder $name)){
      throw 'V3_ATTEMPT_ALREADY_HAS_EVIDENCE_DO_NOT_RETRY'
    }
  }
}
try{
  if($Mode -eq 'Mock'){
    if(-not $MockEvidenceDirectory){throw 'MOCK_DIRECTORY_REQUIRED'}
    $full=[IO.Path]::GetFullPath($MockEvidenceDirectory)
    if((Split-Path $full -Leaf) -notmatch '^rf-v3-mock-[A-Za-z0-9_-]{8,}$'){
      throw 'ONLY_DISPOSABLE_MOCK_FOLDER_ALLOWED'
    }
    if(Test-Path -LiteralPath $full){throw 'MOCK_FOLDER_ALREADY_EXISTS'}
    [void](New-Item -ItemType Directory -Path $full -ErrorAction Stop)
    $script:TracePath=Join-Path $full 'shell-stages.jsonl'
    Emit-SafeStage 'mock_started'
    Emit-SafeStage 'node_launching'
    if($MockScenario -eq 'powershell-error'){
      throw [InvalidOperationException]::new('SYNTHETIC_PS_EXCEPTION')
    }
    if($MockScenario -eq 'shell-pause'){
      Start-Sleep -Seconds 14
      $script:NodeExit=0
    }else{
      $code=@'
const scenario=process.argv[1];
if(scenario==='node-ok')process.exit(0);
if(scenario==='node-exit')process.exit(47);
if(scenario==='node-timeout'){
  const controller=AbortSignal.timeout(60);
  controller.addEventListener('abort',()=>process.exit(48));
  setTimeout(()=>process.exit(49),1000);
}else process.exit(98);
'@
      & node -e $code $MockScenario 1>$null 2>$null
      $script:NodeExit=$LASTEXITCODE
    }
    if($script:NodeExit -ne 0){throw 'SYNTHETIC_NODE_NONZERO'}
    Emit-SafeStage 'node_returned_success'
    $script:Outcome='MOCK_SUCCESS'
  }else{
    if(-not $SandboxCheckout){throw 'PINNED_SANDBOX_DIRECTORY_REQUIRED'}
    $repo=Split-Path $PSScriptRoot -Parent
    $runner=Join-Path $PSScriptRoot 'pr7-v3-one-shot.mjs'
    $engine=(& git -C $repo rev-parse HEAD)
    if($LASTEXITCODE -ne 0 -or $engine -notmatch '^[a-f0-9]{40}$'){
      throw 'ENGINE_REPOSITORY_NOT_PINNED'
    }
    if($Mode -eq 'Paid' -and $ExpectedEngineSha -cne $engine){
      throw 'FRESH_ENGINE_COMMIT_APPROVAL_REQUIRED'
    }
    if($Mode -eq 'Paid' -and $ApprovalId -cne $id){
      throw 'NEW_PAID_ID_APPROVAL_REQUIRED'
    }
    if($env:OPENAI_TEST_API_KEY){throw 'PRESET_TEST_KEY_NOT_ALLOWED'}
    if($env:OPENAI_API_KEY){throw 'LIVE_KEY_NOT_ALLOWED'}
    if($env:RF_APPROVED_PAID_ATTEMPT){throw 'PRESET_APPROVAL_NOT_ALLOWED'}
    & node $runner --preflight $SandboxCheckout
    if($LASTEXITCODE -ne 0){throw 'OFFLINE_SOURCE_PREFLIGHT_FAILED'}
    if($Mode -eq 'Preflight'){
      Write-Output 'RF_V3_PREFLIGHT=PASS; PROVIDER_CALLS=0'
    }else{
      # Resolve the OS account home directly, not environment-controlled TEMP.
      $realHome=(& node -p "require('os').userInfo().homedir")
      if($LASTEXITCODE -ne 0 -or -not [IO.Path]::IsPathRooted($realHome)){
        throw 'OS_USER_HOME_UNAVAILABLE'
      }
      $root=Join-Path $realHome '.reviewforge\benchmark-journal'
      Check-Unused $root
      [void](New-Item -ItemType Directory -Force -Path $root -ErrorAction Stop)
      $script:TracePath=Join-Path $root ($id+'.shell-stages.jsonl')
      Emit-SafeStage 'shell_started'
      Emit-SafeStage 'preflight_verified'
      $secret=Read-Host 'OpenAI TEST API key (hidden)' -AsSecureString
      $ptr=[IntPtr]::Zero
      $plain=$null
      try{
        $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
        $plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
        if(-not $plain -or $plain -notmatch '^sk-(proj-)?[A-Za-z0-9_-]{15,}$'){
          throw 'INVALID_PRIVATE_TEST_KEY'
        }
        Emit-SafeStage 'key_obtained'
        Emit-SafeStage 'node_launching'
        $env:RF_APPROVED_PAID_ATTEMPT=$id
        $env:RF_V3_PINNED_ENGINE=$engine
        $env:OPENAI_TEST_API_KEY=$plain
        & node $runner --execute-paid $SandboxCheckout 1>$null 2>$null
        $script:NodeExit=$LASTEXITCODE
      }finally{
        Remove-Item Env:\OPENAI_TEST_API_KEY -ErrorAction SilentlyContinue
        Remove-Item Env:\RF_APPROVED_PAID_ATTEMPT -ErrorAction SilentlyContinue
        Remove-Item Env:\RF_V3_PINNED_ENGINE -ErrorAction SilentlyContinue
        if($ptr -ne [IntPtr]::Zero){
          [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
        }
        $plain=$null
        $secret=$null
      }
      if($script:NodeExit -ne 0){throw 'NODE_EXITED_UNVERIFIED_DO_NOT_RETRY'}
      Emit-SafeStage 'node_returned_success'
      $script:Outcome='COMPLETED_NODE_EXIT_ZERO'
    }
  }
}catch{
  if($script:TracePath -and $script:TraceExists){
    try{
      if($null -ne $script:NodeExit -and $script:NodeExit -ne 0){
        Emit-SafeStage 'node_returned_failure'
      }
      Emit-SafeStage 'shell_caught_exception'
    }catch{}
  }
  $script:Outcome='FAILED_OR_UNVERIFIED'
}finally{
  if($script:TracePath -and $script:TraceExists){
    try{
      if($script:Outcome -in @('MOCK_SUCCESS','COMPLETED_NODE_EXIT_ZERO')){
        Emit-SafeStage 'shell_terminal_success'
      }else{
        Emit-SafeStage 'shell_terminal_failure'
      }
    }catch{$script:Outcome='FAILED_OR_UNVERIFIED'}
    Write-Output ('RF_V3_OUTCOME='+$script:Outcome)
    Write-Output ('RF_V3_TRACE_PATH='+$script:TracePath)
    Write-Output 'NO_AUTOMATIC_RETRY'
  }elseif($Mode -ne 'Preflight'){
    Write-Output ('RF_V3_OUTCOME='+$script:Outcome)
    Write-Output 'NO_ATTEMPT_TRACE_CREATED'
  }elseif($script:Outcome -eq 'FAILED_OR_UNVERIFIED'){
    Write-Output 'RF_V3_PREFLIGHT=FAILED; PROVIDER_CALLS=0'
  }
}
if($script:Outcome -eq 'FAILED_OR_UNVERIFIED'){exit 1}

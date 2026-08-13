$ErrorActionPreference = 'Stop'

$docker = "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin\docker.exe"
$container = 'supabase_db_Zaki-ledger'

function Invoke-LocalSql([string]$Sql) {
  $output = & $docker exec $container psql -v ON_ERROR_STOP=1 -U postgres -d postgres -Atc $Sql 2>&1
  if ($LASTEXITCODE -ne 0) { throw ($output -join "`n") }
  return ($output -join "`n").Trim()
}

function Invoke-ParallelSql([string[]]$Statements) {
  $jobs = foreach ($statement in $Statements) {
    Start-Job -ArgumentList $docker,$container,$statement -ScriptBlock {
      param($dockerPath, $containerName, $sql)
      $output = & $dockerPath exec $containerName psql -v ON_ERROR_STOP=1 -U postgres -d postgres -Atc $sql 2>&1
      [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($output -join "`n") }
    }
  }
  $results = @($jobs | Wait-Job | Receive-Job)
  $jobs | Remove-Job -Force
  if ($results | Where-Object ExitCode -ne 0) {
    throw "011 concurrent bootstrap failed: $($results | ForEach-Object Output)"
  }
  return $results
}

$sameUser = [guid]::NewGuid().ToString()
$differentUser = [guid]::NewGuid().ToString()
$timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

Invoke-LocalSql "INSERT INTO auth.users (id,email,role,aud,email_confirmed_at,created_at,updated_at) VALUES ('$sameUser','011-same-$timestamp@example.test','authenticated','authenticated',now(),now(),now()),('$differentUser','011-different-$timestamp@example.test','authenticated','authenticated',now(),now(),now());" | Out-Null

$sameSql = "SELECT public.ensure_default_tenant_for_user_v1('$sameUser'::uuid);"
$differentSql = "SELECT public.ensure_default_tenant_for_user_v1('$differentUser'::uuid);"

# 4: two sessions for one user serialize to one complete graph.
$sameResults = Invoke-ParallelSql @($sameSql, $sameSql)
$sameCounts = Invoke-LocalSql "SELECT count(*) || ',' || count(DISTINCT d.practice_id) || ',' || count(DISTINCT d.practice_membership_id) || ',' || count(DISTINCT d.client_entity_id) || ',' || count(DISTINCT d.internal_ledger_book_id) FROM public.default_tenant_identities d WHERE d.user_id='$sameUser'::uuid;"
if ($sameCounts -ne '1,1,1,1,1') { throw "same-user postcondition failed: $sameCounts" }

# 5: separate advisory keys do not require serial execution; both complete.
$started = [Diagnostics.Stopwatch]::StartNew()
$differentResults = Invoke-ParallelSql @($sameSql, $differentSql)
$started.Stop()
$differentCounts = Invoke-LocalSql "SELECT count(*) FROM public.default_tenant_identities d WHERE d.user_id IN ('$sameUser'::uuid, '$differentUser'::uuid);"
if ($differentCounts -ne '2') { throw "different-user postcondition failed: $differentCounts" }

$auditCounts = Invoke-LocalSql "SELECT count(*) FROM public.canonical_audit_ledger WHERE metadata_redacted->>'bootstrap_version'='011' AND metadata_redacted->>'bootstrap_target_user_id' IN ('$sameUser','$differentUser');"
if ([int]$auditCounts -lt 12) { throw "concurrent bootstrap audit evidence missing: $auditCounts" }

"011_CONCURRENCY_OK same_user=$sameCounts different_users=$differentCounts elapsed_ms=$($started.ElapsedMilliseconds) same_calls=$($sameResults.Count) different_calls=$($differentResults.Count) audit_rows=$auditCounts"

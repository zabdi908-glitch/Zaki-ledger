$ErrorActionPreference = 'Stop'
$docker = "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin\docker.exe"
$container = 'supabase_db_Zaki-ledger'

function Invoke-ParallelSql([string[]]$Statements) {
  $jobs = foreach ($statement in $Statements) {
    Start-Job -ArgumentList $docker,$container,$statement -ScriptBlock {
      param($dockerPath,$containerName,$sql)
      $output = & $dockerPath exec $containerName psql -v ON_ERROR_STOP=1 -U postgres -d postgres -Atc $sql 2>&1
      $exitCode = $LASTEXITCODE
      [pscustomobject]@{ ExitCode = $exitCode; Output = ($output -join "`n") }
    }
  }
  $results = $jobs | Wait-Job | Receive-Job
  $jobs | Remove-Job -Force
  return @($results)
}

$revisionSql = "SELECT public.append_financial_event_revision_v1('94000000-0000-0000-0000-000000000001','95000000-0000-0000-0000-000000000001',jsonb_build_object('event_kind','payment','resolution_status','resolved','amount_minor','1000','currency_code','GBP','minor_unit_exponent','2','direction','outflow'),'service',NULL,'canonical-test',NULL);"
$revisionResults = Invoke-ParallelSql @($revisionSql,$revisionSql)

$claimTemplate = "SELECT public.create_financial_identity_claim_v1('94000000-0000-0000-0000-000000000001','{0}',jsonb_build_object('claim_kind','manual_adjudication','strength','strong','namespace_canonical','manual|concurrency','claim_key_canonical','same-reviewed-identity','namespace_hash_hex','{1}','claim_key_hash_hex','{2}','components','{{}}'::jsonb),'service',NULL,'canonical-test',NULL);"
$nsHash = ('11' * 32)
$keyHash = ('22' * 32)
$claimResults = Invoke-ParallelSql @(
  ($claimTemplate -f '97000000-0000-0000-0000-000000000001',$nsHash,$keyHash),
  ($claimTemplate -f '97000000-0000-0000-0000-000000000002',$nsHash,$keyHash)
)

$allocationSql = "SELECT public.allocate_financial_relationship_v1('94000000-0000-0000-0000-000000000001','98000000-0000-0000-0000-000000000001','98100000-0000-0000-0000-000000000001','98100000-0000-0000-0000-000000000002',jsonb_build_object('source_amount_minor','600','source_currency_code','GBP','source_minor_unit_exponent','2','target_amount_minor','600','target_currency_code','GBP','target_minor_unit_exponent','2','status','confirmed'),'service',NULL,'canonical-test',NULL);"
$allocationResults = Invoke-ParallelSql @($allocationSql,$allocationSql)

$atomicSql = "SELECT public.ingest_financial_observation_v1('94000000-0000-0000-0000-000000000001',jsonb_build_object('observation_kind','ledger_posting','provider_connection_id','94200000-0000-0000-0000-000000000001','ledger_book_id','94100000-0000-0000-0000-000000000001'),jsonb_build_object('source_status','posted','amount_minor','1000','currency_code','GBP','minor_unit_exponent','2','direction','outflow','raw_payload_hash_hex',repeat('cc',32)),jsonb_build_array(jsonb_build_object('claim_kind','quickbooks_object_id','strength','authoritative','namespace_canonical','quickbooks|concurrency-realm|purchase','claim_key_canonical','CONCURRENT-42','components',jsonb_build_object('object_type','purchase'))),jsonb_build_object('event_kind','payment','resolution_status','resolved','amount_minor','1000','currency_code','GBP','minor_unit_exponent','2','direction','outflow'),'service',NULL,'canonical-test',NULL);"
$atomicResults = Invoke-ParallelSql @($atomicSql,$atomicSql)

$occurrenceSql = "SELECT public.record_financial_observation_occurrence_v1('94000000-0000-0000-0000-000000000001','97000000-0000-0000-0000-000000000001','94400000-0000-0000-0000-000000000001','94300000-0000-0000-0000-000000000001',jsonb_build_object('source_locator','row:1','source_row_number','1','raw_payload_hash_hex',repeat('dd',32)),'service',NULL,'canonical-test',NULL);"
$occurrenceResults = Invoke-ParallelSql @($occurrenceSql,$occurrenceSql)

$mergeForward = "SELECT public.merge_financial_events_v1('94000000-0000-0000-0000-000000000001','99000000-0000-0000-0000-000000000001','99000000-0000-0000-0000-000000000002','concurrent merge',jsonb_build_object(),'service',NULL,'canonical-test',NULL);"
$mergeReverseDirection = "SELECT public.merge_financial_events_v1('94000000-0000-0000-0000-000000000001','99000000-0000-0000-0000-000000000002','99000000-0000-0000-0000-000000000001','concurrent inverse merge',jsonb_build_object(),'service',NULL,'canonical-test',NULL);"
$mergeResults = Invoke-ParallelSql @($mergeForward,$mergeReverseDirection)

$revisionCount = & $docker exec $container psql -U postgres -d postgres -Atc "SELECT count(*) FROM public.financial_event_revisions WHERE event_id='95000000-0000-0000-0000-000000000001';"
$claimCount = & $docker exec $container psql -U postgres -d postgres -Atc "SELECT count(*) FROM public.financial_identity_claims WHERE namespace_canonical='manual|concurrency' AND claim_key_canonical='same-reviewed-identity' AND status='active';"
$allocationCount = & $docker exec $container psql -U postgres -d postgres -Atc "SELECT count(*) FROM public.financial_allocations WHERE relationship_id='98000000-0000-0000-0000-000000000001' AND status='confirmed';"
$atomicObservationCount = & $docker exec $container psql -U postgres -d postgres -Atc "SELECT count(DISTINCT observation_id) FROM public.financial_identity_claims WHERE namespace_canonical='quickbooks|concurrency-realm|purchase' AND claim_key_canonical='CONCURRENT-42' AND status='active';"
$atomicLinkCount = & $docker exec $container psql -U postgres -d postgres -Atc "SELECT count(*) FROM public.financial_event_observation_links l JOIN public.financial_identity_claims c ON c.observation_id=l.observation_id WHERE c.namespace_canonical='quickbooks|concurrency-realm|purchase' AND c.claim_key_canonical='CONCURRENT-42' AND l.valid_to IS NULL;"
$occurrenceCount = & $docker exec $container psql -U postgres -d postgres -Atc "SELECT count(*) FROM public.financial_observation_occurrences WHERE import_run_id='94400000-0000-0000-0000-000000000001' AND source_locator='row:1';"
$mergeAliasCount = & $docker exec $container psql -U postgres -d postgres -Atc "SELECT count(*) FROM public.financial_event_aliases WHERE alias_event_id IN ('99000000-0000-0000-0000-000000000001','99000000-0000-0000-0000-000000000002') AND valid_to IS NULL;"
if ($revisionCount -ne '3' -or $claimCount -ne '1' -or $allocationCount -ne '1' -or $atomicObservationCount -ne '1' -or $atomicLinkCount -ne '1' -or $occurrenceCount -ne '1' -or $mergeAliasCount -ne '1') {
  throw "concurrency postconditions failed: revisions=$revisionCount claims=$claimCount allocations=$allocationCount atomic_observations=$atomicObservationCount atomic_links=$atomicLinkCount occurrences=$occurrenceCount merge_aliases=$mergeAliasCount"
}
"CONCURRENCY_OK revisions=$revisionCount claims=$claimCount allocations=$allocationCount atomic_observations=$atomicObservationCount atomic_links=$atomicLinkCount occurrences=$occurrenceCount merge_aliases=$mergeAliasCount"

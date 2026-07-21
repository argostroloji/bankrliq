# BANKRLIQ — close position #267073 via direct wallet submit.
# Reads close-tx.json and submits with explicit flags (no JSON-arg parsing).
$ErrorActionPreference = "Stop"
$tx = Get-Content "$PSScriptRoot\close-tx.json" -Raw | ConvertFrom-Json
Write-Host "Submitting close for position #267073 to $($tx.to) on chain $($tx.chainId)..." -ForegroundColor Cyan
bankr wallet submit tx --to $tx.to --chain-id $tx.chainId --value 0 --data $tx.data --description "BANKRLIQ close #267073"

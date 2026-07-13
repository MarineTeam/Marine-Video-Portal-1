<#
.SYNOPSIS
  Grab the latest CI run for this repo and watch it to completion; exit non-zero on failure.

.DESCRIPTION
  Read-only. Uses the gh CLI (full path - gh.exe is off-PATH on the maintainer
  machine; session record, 2026-07-10, maintainer-confirmed). The workflow file
  is .github/workflows/ci.yml and the workflow display name is "CI" (verified
  against the repo). If the latest run is already completed, reports its
  conclusion immediately instead of watching.

.USAGE
  powershell -ExecutionPolicy Bypass -File .claude\skills\diagnostics-and-tooling\scripts\watch-ci.ps1
  # overrides:
  #   ... -Repo owner/name -GhExe 'D:\tools\gh.exe'

.NOTES
  VERIFICATION STATUS: executed end-to-end on the maintainer machine
  (2026-07-11); latest run 29069160341 was already completed with
  conclusion=success, so the already-completed fast path is exercised and the
  script exited 0. The live `gh run watch --exit-status` path uses a standard,
  documented gh subcommand but was NOT exercised (no run was in progress at
  authoring time).

  Exit codes: 0 = run succeeded; 1 = run failed/cancelled; 2 = could not query.
#>
[CmdletBinding()]
param(
  [string]$Repo = 'MarineTeam/Marine-Video-Portal-1',
  [string]$GhExe = 'C:\Program Files\GitHub CLI\gh.exe'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $GhExe)) {
  Write-Host "ERROR: gh CLI not found at '$GhExe'. Pass -GhExe <full path to gh.exe>."
  exit 2
}

$json = & $GhExe run list --repo $Repo --workflow=ci.yml --limit 1 --json databaseId,status,conclusion,displayTitle,headBranch
if ($LASTEXITCODE -ne 0) {
  Write-Host 'ERROR: gh run list failed - see the gh error above.'
  exit 2
}

$runs = @($json | ConvertFrom-Json)
if ($runs.Count -eq 0) {
  Write-Host "ERROR: no runs found for workflow ci.yml in $Repo."
  exit 2
}

$run = $runs[0]
Write-Host "Latest CI run: $($run.databaseId) - '$($run.displayTitle)' [branch: $($run.headBranch)] status=$($run.status)"

if ($run.status -ne 'completed') {
  Write-Host "Watching run $($run.databaseId) to completion (Ctrl+C to stop watching; the run keeps going)..."
  & $GhExe run watch $run.databaseId --repo $Repo --exit-status
  $watchExit = $LASTEXITCODE
} else {
  $watchExit = 0
  if ($run.conclusion -ne 'success') { $watchExit = 1 }
}

# Re-read the conclusion from the API rather than trusting local state.
$conclusion = & $GhExe run view $run.databaseId --repo $Repo --json conclusion --jq .conclusion
Write-Host "CI run $($run.databaseId) conclusion: $conclusion"

if ($watchExit -ne 0) {
  Write-Host 'Run did not succeed. Pull the failed-step logs with:'
  Write-Host "  & `"$GhExe`" run view $($run.databaseId) --repo $Repo --log-failed"
  exit 1
}
exit 0

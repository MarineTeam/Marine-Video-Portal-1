<#
.SYNOPSIS
  Summarize open Dependabot and CodeQL (code-scanning) alerts for a GitHub repo.

.DESCRIPTION
  Read-only. Calls the GitHub REST API through the gh CLI using its full path
  (gh.exe is installed but off-PATH on the maintainer machine - session record,
  2026-07-10, maintainer-confirmed). Prints one table per scanner plus severity
  counts, and a graceful "None." when a scanner has zero open alerts.

.USAGE
  powershell -ExecutionPolicy Bypass -File .claude\skills\diagnostics-and-tooling\scripts\check-alerts.ps1
  # overrides:
  #   ... -Repo owner/name -GhExe 'D:\tools\gh.exe'

.NOTES
  VERIFICATION STATUS: executed end-to-end on the maintainer machine
  (2026-07-11) against MarineTeam/Marine-Video-Portal-1; returned 14 open
  Dependabot alerts and 3 open CodeQL alerts, matching the GitHub UI counts.

  The jq filters deliberately contain NO double quotes: PowerShell 5.1 mangles
  embedded " when passing arguments to native executables, so open-state
  filtering is done with ?state=open in the URL instead of jq select().
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

# Emits one JSON object per line (NDJSON), so --paginate can never produce the
# concatenated-arrays output ("[...][...]") that breaks ConvertFrom-Json.
function Get-OpenAlerts {
  param([string]$Endpoint, [string]$JqFilter)
  $lines = & $GhExe api $Endpoint --paginate --jq $JqFilter
  if ($LASTEXITCODE -ne 0) {
    return @{ Ok = $false; Alerts = @() }
  }
  $alerts = @($lines | Where-Object { $_ } | ForEach-Object { ConvertFrom-Json $_ })
  return @{ Ok = $true; Alerts = $alerts }
}

function Show-AlertTable {
  param($Result, [string]$Title, [string[]]$Columns)
  Write-Host ''
  Write-Host "== $Title ($Repo) =="
  if (-not $Result.Ok) {
    Write-Host 'QUERY FAILED - see the gh error above. Common causes: token missing the'
    Write-Host 'security_events / repo scope, or this scanner is not enabled on the repo.'
    return $false
  }
  if ($Result.Alerts.Count -eq 0) {
    Write-Host 'None. 0 open alerts.'
    return $true
  }
  $table = $Result.Alerts |
    Sort-Object severity, number |
    Format-Table -AutoSize -Property $Columns |
    Out-String -Width 220
  Write-Host $table.TrimEnd()
  $counts = ($Result.Alerts | Group-Object severity | Sort-Object Name |
    ForEach-Object { "$($_.Name)=$($_.Count)" }) -join ', '
  Write-Host "Total: $($Result.Alerts.Count) open ($counts)"
  return $true
}

$depJq  = '.[] | {number, package: .security_vulnerability.package.name, severity: .security_vulnerability.severity, patched: .security_vulnerability.first_patched_version.identifier, summary: .security_advisory.summary}'
$cqlJq  = '.[] | {number, rule: .rule.id, severity: .rule.severity, path: .most_recent_instance.location.path, line: .most_recent_instance.location.start_line}'

$dep = Get-OpenAlerts -Endpoint "repos/$Repo/dependabot/alerts?state=open&per_page=100"    -JqFilter $depJq
$cql = Get-OpenAlerts -Endpoint "repos/$Repo/code-scanning/alerts?state=open&per_page=100" -JqFilter $cqlJq

$depOk = Show-AlertTable -Result $dep -Title 'Dependabot open alerts' -Columns @('number', 'severity', 'package', 'patched', 'summary')
$cqlOk = Show-AlertTable -Result $cql -Title 'CodeQL open alerts'     -Columns @('number', 'severity', 'rule', 'path', 'line')

Write-Host ''
if (-not ($depOk -and $cqlOk)) { exit 1 }
exit 0

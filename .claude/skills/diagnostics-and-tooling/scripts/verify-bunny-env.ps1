<#
.SYNOPSIS
  Verify Bunny Stream credentials: flag edge whitespace (the TUS-401 killer) and
  test the key against the Bunny API. NEVER prints the key itself.

.DESCRIPTION
  Two independent checks, because they fail independently:
    1. Leading/trailing whitespace in the library id or API key. A stray
       newline/space is silently dropped from the AccessKey HTTP header (so
       plain API calls still work) but corrupts the SHA256 TUS upload
       signature -> HTTP 401 on upload. This exact failure was fixed in commit
       8e81183 ("Fix TUS upload 401: revert to seconds expiry, trim env values").
    2. An HTTP GET of the video-list endpoint with the TRIMMED values, to prove
       the key itself is valid for the library.

  Output is key-safe: prints only the key's length and a 12-hex-char SHA256
  fingerprint (safe to compare against the value stored in Vercel from another
  machine). Treat the endpoint RESPONSE as sensitive anyway - it contains video
  titles and guids.

.USAGE
  # from env vars:
  powershell -ExecutionPolicy Bypass -File .claude\skills\diagnostics-and-tooling\scripts\verify-bunny-env.ps1
  # or explicit:
  #   ... -LibraryId 123456 -ApiKey (real key)

.NOTES
  VERIFICATION STATUS: executed on the maintainer machine (2026-07-11).
  Exercised live: the missing-credentials path (exit 2), the whitespace-flag
  path (dummy key with trailing \n -> "TRAILING whitespace char (U+000A)"
  reported), the key fingerprint, and the invalid-credentials path against the
  real Bunny endpoint (HTTP 401 detected and reported, exit 1). NOT exercised:
  the HTTP 200 success path (no real key was available at authoring time);
  that branch is straight-line code reviewed by inspection.

  Exit codes: 0 = 200 OK and no whitespace problems; 1 = whitespace found
  and/or non-200; 2 = missing inputs.
#>
[CmdletBinding()]
param(
  [string]$LibraryId = $env:BUNNY_LIBRARY_ID,
  [string]$ApiKey = $env:BUNNY_API_KEY
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrEmpty($LibraryId)) {
  Write-Host 'ERROR: no library id. Pass -LibraryId or set $env:BUNNY_LIBRARY_ID first.'
  exit 2
}
if ([string]::IsNullOrEmpty($ApiKey)) {
  Write-Host 'ERROR: no API key. Pass -ApiKey or set $env:BUNNY_API_KEY first.'
  exit 2
}

# --- Check 1: edge whitespace (reports the exact char, never the value) ------
function Test-EdgeWhitespace {
  param([string]$Name, [string]$Value)
  $found = $false
  if ($Value.Length -gt 0 -and [char]::IsWhiteSpace($Value[0])) {
    Write-Host ('WHITESPACE: {0} has a LEADING whitespace char (U+{1:X4}).' -f $Name, [int]$Value[0])
    $found = $true
  }
  if ($Value.Length -gt 0 -and [char]::IsWhiteSpace($Value[$Value.Length - 1])) {
    Write-Host ('WHITESPACE: {0} has a TRAILING whitespace char (U+{1:X4}).' -f $Name, [int]$Value[$Value.Length - 1])
    $found = $true
  }
  if ($found) {
    Write-Host '  -> TUS-401 killer (commit 8e81183): the AccessKey header silently drops'
    Write-Host '     this char, so createVideo works, but the SHA256 TUS signature is'
    Write-Host '     computed over the corrupted value -> HTTP 401 on the browser upload.'
    Write-Host '     Fix: re-save the env var (Vercel dashboard) without the whitespace.'
  } else {
    Write-Host "OK: $Name has no leading/trailing whitespace."
  }
  return $found
}

$whitespaceProblems = 0
if (Test-EdgeWhitespace -Name 'LibraryId' -Value $LibraryId) { $whitespaceProblems++ }
if (Test-EdgeWhitespace -Name 'ApiKey'    -Value $ApiKey)    { $whitespaceProblems++ }

$lib = $LibraryId.Trim()
$key = $ApiKey.Trim()

# Key fingerprint: lets you compare this machine's key with the one in Vercel
# without either side ever revealing the key.
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $hashBytes = $sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($key))
} finally {
  $sha256.Dispose()
}
$fingerprint = (($hashBytes | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 12)
Write-Host "ApiKey (trimmed): length=$($key.Length) chars, sha256 fingerprint=$fingerprint (key itself is never printed)."

# --- Check 2: does Bunny accept the trimmed key? ------------------------------
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$uri = "https://video.bunnycdn.com/library/$lib/videos?page=1&itemsPerPage=1"
Write-Host "GET $uri"

$status = $null
try {
  $resp = Invoke-RestMethod -Uri $uri -Method Get -Headers @{ AccessKey = $key; accept = 'application/json' } -ErrorAction Stop
  $status = 200
  Write-Host "HTTP 200 - key accepted for library $lib. totalItems=$($resp.totalItems), items in this page=$(@($resp.items).Count)."
} catch {
  if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
  if ($status -eq 401) {
    Write-Host 'HTTP 401 Unauthorized - the (trimmed) API key is not valid for this library.'
    Write-Host 'Re-copy the key: bunny.net dashboard -> Stream -> your library -> API.'
  } elseif ($status -eq 404) {
    Write-Host "HTTP 404 - library id '$lib' not found. Wrong BUNNY_LIBRARY_ID?"
  } elseif ($null -ne $status) {
    Write-Host "HTTP $status - unexpected. $($_.Exception.Message)"
  } else {
    Write-Host "Request failed before any HTTP status was received (DNS/proxy/TLS?): $($_.Exception.Message)"
  }
}

Write-Host ''
if ($status -eq 200 -and $whitespaceProblems -eq 0) {
  Write-Host 'RESULT: PASS - credentials valid, no whitespace problems.'
  exit 0
}
Write-Host "RESULT: FAIL - http_status=$status, whitespace_problems=$whitespaceProblems"
exit 1

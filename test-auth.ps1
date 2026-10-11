# test-auth.ps1
$BASE = 'http://localhost:8080'
$Session = New-Object Microsoft.PowerShell.Commands.WebRequestSession

function Section($t) { Write-Host ""; Write-Host "> $t" -ForegroundColor Cyan }
function Show($o) { if ($null -eq $o) { Write-Host "  (null)" } else { $o | ConvertTo-Json -Depth 6 | Write-Host } }

function Try-Request {
  param([string]$Method, [string]$Url, $Body, [switch]$UseSession)
  try {
    $p = @{ Method = $Method; Uri = $Url; ContentType = 'application/json'; ErrorAction = 'Stop' }
    if ($Body) { $p.Body = ($Body | ConvertTo-Json -Compress) }
    if ($UseSession) { $p.WebSession = $Session }
    return Invoke-RestMethod @p
  } catch {
    $resp = $_.Exception.Response
    if ($resp) {
      try {
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $body = $reader.ReadToEnd()
        Write-Host "  HTTP $([int]$resp.StatusCode)" -ForegroundColor Yellow
        try { return $body | ConvertFrom-Json } catch { return $body }
      } catch {}
    }
    Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Red
    return $null
  }
}

Section "Ping al server"
try {
  Invoke-RestMethod -Uri "$BASE/api/health" -ErrorAction Stop | Out-Null
  Write-Host "  OK - server vivo" -ForegroundColor Green
} catch {
  Write-Host "  El server NO responde" -ForegroundColor Red
  exit 1
}

$body = @{ email = 'test@test.com'; password = 'test1234' }

Section "Signup"
Show (Try-Request -Method POST -Url "$BASE/api/auth/signup" -Body $body -UseSession)

Section "Login"
Show (Try-Request -Method POST -Url "$BASE/api/auth/login" -Body $body -UseSession)

Section "Session"
Show (Try-Request -Method GET -Url "$BASE/api/auth/session" -UseSession)

Section "Me"
Show (Try-Request -Method GET -Url "$BASE/api/auth/me" -UseSession)

Section "Forgot"
Show (Try-Request -Method POST -Url "$BASE/api/auth/forgot-password" -Body @{ email = 'test@test.com' } -UseSession)

Section "Logout"
Show (Try-Request -Method POST -Url "$BASE/api/auth/logout" -UseSession)

Write-Host ""
Write-Host "Tests completados" -ForegroundColor Green

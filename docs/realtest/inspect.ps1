$f = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@dickpy\dsh-imagegen\lib\index.js"
$c = [System.IO.File]::ReadAllText($f)

Write-Host "=== fetch( call sites ==="
$m = [regex]::Matches($c, '.{0,130}fetch\(.{0,150}')
$m | Select-Object -First 5 | ForEach-Object { Write-Host ('  ' + ($_.Value -replace '\s+',' ')); Write-Host '' }

Write-Host "=== http layer keywords ==="
foreach ($p in @('ProxyAgent','setGlobalDispatcher','undici','node:http','node:https','axios','request(')) {
  $n = ([regex]::Matches($c, [regex]::Escape($p))).Count
  Write-Host ("  {0,-22} {1}" -f $p, $n)
}

Write-Host ''
Write-Host "=== context around response_format + b64 ==="
$m2 = [regex]::Matches($c, '.{0,420}response_format: "b64_json".{0,120}')
if ($m2.Count -gt 0) { Write-Host ($m2[0].Value -replace '\s+',' ') }

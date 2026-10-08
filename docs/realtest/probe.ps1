$ProgressPreference = 'SilentlyContinue'
$key = process.env.AIDRAMA_KEY ?? ''
$url = 'https://coderxiaoc.com/v1/images/generations'

function C([string]$label, [string]$json) {
  $in = Join-Path $env:TEMP 'req.json'
  $out = Join-Path $env:TEMP 'resp.json'
  [System.IO.File]::WriteAllText($in, $json, [System.Text.Encoding]::ASCII)
  $code = & curl.exe -sS -o $out -w '%{http_code}' -X POST $url `
    -H "Authorization: Bearer $key" -H 'Content-Type: application/json' `
    --data-binary "@$in" --max-time 150 2>$null
  $len = 0
  if (Test-Path $out) { $len = (Get-Item $out).Length }
  $head = ''
  if ($len -gt 0) {
    $raw = [System.IO.File]::ReadAllText($out)
    $head = $raw.Substring(0, [Math]::Min(150, $raw.Length)) -replace '\s+', ' '
  }
  Write-Host ("{0,-42} HTTP {1}  {2,8} bytes  {3}" -f $label, $code, $len, $head)
}

C 'A. prompt+n+size'                 '{"model":"gpt-image-2.5-sunburst","prompt":"a red apple","n":1,"size":"1024x1024"}'
C 'B. +response_format=b64_json'     '{"model":"gpt-image-2.5-sunburst","prompt":"a red apple","n":1,"size":"1024x1024","response_format":"b64_json"}'
C 'C. +quality=auto +b64'            '{"model":"gpt-image-2.5-sunburst","prompt":"a red apple","n":1,"size":"1024x1024","quality":"auto","response_format":"b64_json"}'
C 'D. size=1080x1920 (9:16) +b64'    '{"model":"gpt-image-2.5-sunburst","prompt":"a red apple","n":1,"size":"1080x1920","response_format":"b64_json"}'
C 'E. quality=2k +b64'               '{"model":"gpt-image-2.5-sunburst","prompt":"a red apple","n":1,"size":"1024x1024","quality":"2k","response_format":"b64_json"}'
C 'F. flare +b64'                    '{"model":"gpt-image-2.5-flare","prompt":"a red apple","n":1,"size":"1024x1024","response_format":"b64_json"}'

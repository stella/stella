Get-ChildItem Cert:\CurrentUser\My |
  Where-Object Subject -like "CN=$env:STELLA_SIGNING_FIXTURE_PREFIX-*" |
  ForEach-Object {
    if ($_.HasPrivateKey) { Remove-Item -Path $_.PSPath -DeleteKey } else { Remove-Item -Path $_.PSPath }
  }

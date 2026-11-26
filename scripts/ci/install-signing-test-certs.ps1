$ErrorActionPreference = 'Stop'
$prefix = $env:STELLA_SIGNING_FIXTURE_PREFIX
$store = 'Cert:\CurrentUser\My'
$documents = '2.5.29.37={text}1.3.6.1.5.5.7.3.4'
$loginOnly = '2.5.29.37={text}1.3.6.1.5.5.7.3.2'
$common = @{
  CertStoreLocation = $store
  Type = 'Custom'
  Provider = 'Microsoft Software Key Storage Provider'
  KeyExportPolicy = 'NonExportable'
  NotAfter = (Get-Date).AddDays(2)
}
$rsa = @{ KeyAlgorithm = 'RSA'; KeyLength = 2048 }
New-SelfSignedCertificate @common @rsa -Subject "CN=$prefix-rsa" -KeyUsage DigitalSignature, NonRepudiation -TextExtension @($documents) | Out-Null
New-SelfSignedCertificate @common -Subject "CN=$prefix-ec" -KeyAlgorithm ECDSA_nistP256 -CurveExport CurveName -KeyUsage DigitalSignature -TextExtension @($documents) | Out-Null
New-SelfSignedCertificate @common @rsa -Subject "CN=$prefix-client-auth" -KeyUsage DigitalSignature -TextExtension @($loginOnly) | Out-Null
$expired = $common.Clone()
$expired.NotBefore = (Get-Date).AddDays(-10)
$expired.NotAfter = (Get-Date).AddDays(-1)
New-SelfSignedCertificate @expired @rsa -Subject "CN=$prefix-expired" -KeyUsage DigitalSignature -TextExtension @($documents) | Out-Null
# Keep only the public half of this one: a certificate whose key is gone.
$keyed = New-SelfSignedCertificate @common @rsa -Subject "CN=$prefix-no-key" -KeyUsage DigitalSignature -TextExtension @($documents)
$public = Join-Path $env:RUNNER_TEMP "$prefix-no-key.cer"
Export-Certificate -Cert $keyed -FilePath $public | Out-Null
Remove-Item -Path $keyed.PSPath -DeleteKey
Import-Certificate -FilePath $public -CertStoreLocation $store | Out-Null

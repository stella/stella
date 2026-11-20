$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

function Save-ReleaseAsset([string]$Url, [string]$Destination) {
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(300)
    try {
        $uri = [Uri]$Url
        for ($redirect = 0; $redirect -le 10; $redirect++) {
            if ($uri.Scheme -ne 'https') { throw 'Release downloads and redirects must use HTTPS.' }
            $response = $client.GetAsync($uri).GetAwaiter().GetResult()
            try {
                if ([int]$response.StatusCode -in @(301, 302, 303, 307, 308)) {
                    if (-not $response.Headers.Location) { throw 'Release redirect has no location.' }
                    $uri = [Uri]::new($uri, $response.Headers.Location)
                    continue
                }
                $response.EnsureSuccessStatusCode() | Out-Null
                [System.IO.File]::WriteAllBytes($Destination, $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult())
                return
            } finally { $response.Dispose() }
        }
        throw 'Too many release redirects.'
    } finally { $client.Dispose() }
}

function Set-StellaUserPath {
    param([string]$Directory)
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try {
        # Preserve references such as %USERPROFILE% instead of expanding them into the stored value.
        $userPath = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $entries = @($userPath -split ';' | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\', '/') })
        if ($entries -notcontains $Directory.TrimEnd('\', '/')) {
            $key.SetValue('Path', "$Directory;$userPath", [Microsoft.Win32.RegistryValueKind]::ExpandString)
        }
    } finally { $key.Dispose() }
}

$platform = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
if ($platform -notmatch 'Windows' -or $arch -ne 'X64') { throw 'Only Windows x64 is supported. Use install.sh on macOS or Linux.' }
$asset = 'stella-windows-x64.exe'
$base = 'https://github.com/stella/stella/releases'
if ($env:STELLA_VERSION) {
    $version = $env:STELLA_VERSION -replace '^v', ''
    if ($version -notmatch '^[0-9A-Za-z.-]+$') { throw 'Invalid STELLA_VERSION.' }
    $release = "$base/download/v$version"
} else { $release = "$base/latest/download" }
$installDir = if ($env:STELLA_INSTALL_DIR) { $env:STELLA_INSTALL_DIR } else { Join-Path $HOME '.local/bin' }
if (-not [System.IO.Path]::IsPathRooted($installDir)) { throw 'STELLA_INSTALL_DIR must be absolute.' }
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$staging = Join-Path $installDir ('.stella-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null
try {
    $binary = Join-Path $staging $asset
    Save-ReleaseAsset "$release/$asset" $binary
    $checksums = Join-Path $staging 'checksums.txt'
    Save-ReleaseAsset "$release/checksums.txt" $checksums
    $entries = @(Get-Content $checksums | Where-Object { $_ -match '^([0-9a-fA-F]{64})  stella-windows-x64\.exe$' })
    if ($entries.Count -ne 1) { throw 'Missing or invalid release checksum.' }
    $expected = ($entries[0] -split '\s+')[0]
    $actual = (Get-FileHash -Algorithm SHA256 -Path $binary).Hash
    if ($actual -ne $expected) { throw 'Checksum mismatch; installation refused.' }
    $destination = Join-Path $installDir 'stella.exe'
    # Replace atomically on the same volume; preserve an existing install on failure.
    if (Test-Path $destination) { [System.IO.File]::Replace($binary, $destination, $null) }
    else { Move-Item -Path $binary -Destination $destination }
    $configHome = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { Join-Path $HOME '.config' }
    $configDir = Join-Path $configHome 'stella'
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $configDir 'install-channel'), "native`n")
    [System.IO.File]::WriteAllText((Join-Path $configDir 'install-path'), "$destination`n")
    $pathEntries = @($env:PATH -split ';' | ForEach-Object { $_.TrimEnd('\', '/') })
    if ($pathEntries -notcontains $installDir.TrimEnd('\', '/')) {
        if ($env:STELLA_NO_MODIFY_PATH -eq '1') {
            $quotedDir = $installDir.Replace("'", "''")
            Write-Output 'function Set-StellaUserPath {'
            Write-Output ${function:Set-StellaUserPath}.ToString()
            Write-Output '}'
            Write-Output "Set-StellaUserPath '$quotedDir'"
        } else {
            Set-StellaUserPath $installDir
            $env:PATH = "$installDir;$env:PATH"
        }
    }
    Write-Output "Installed stella to $destination"
    Write-Output 'Next: stella auth login'
} finally { Remove-Item -Recurse -Force $staging }

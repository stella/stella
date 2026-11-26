$ErrorActionPreference = 'Stop'
$tools = @{}
$tools.bun = (& bun --version) -join "`n"
if ($LASTEXITCODE -ne 0) { throw "Bun version unavailable" }
$tools.rust = (& rustc -vV) -join "`n"
if ($LASTEXITCODE -ne 0) { throw "Rust version unavailable" }
$tools.cargo = (& cargo -V) -join "`n"
if ($LASTEXITCODE -ne 0) { throw "Cargo version unavailable" }
$tools.node = (& node --version) -join "`n"
if ($LASTEXITCODE -ne 0) { throw "Node version unavailable" }
$tools.tauri = (& bun run --cwd apps/desktop tauri --version) -join "`n"
if ($LASTEXITCODE -ne 0) { throw "Tauri version unavailable" }
$tools.image = $env:ImageVersion
$tools.os = $env:ImageOS
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -format json | ConvertFrom-Json) | Select-Object -First 1
if (-not $vs) { throw "Visual Studio version unavailable" }
$tools.visualStudio = $vs.installationVersion
$tools.msvc = (Get-ChildItem "$($vs.installationPath)\VC\Tools\MSVC" -Directory | Sort-Object Name | ForEach-Object Name) -join ','
$tools.sdk = (Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\Lib\10.*" -Directory | Sort-Object Name | ForEach-Object Name) -join ','
if ($tools.Values | Where-Object { [string]::IsNullOrWhiteSpace($_) }) { throw "Incomplete Windows toolchain" }
$tools | ConvertTo-Json | Set-Content "$env:RUNNER_TEMP/windows-tools.json" -Encoding utf8

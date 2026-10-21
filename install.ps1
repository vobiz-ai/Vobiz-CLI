# Vobiz CLI installer for Windows (PowerShell 5.1+ or PowerShell 7).
#
#   irm https://raw.githubusercontent.com/vobiz-ai/Vobiz-CLI/main/install.ps1 | iex
#
# Downloads the Windows release archive from GitHub Releases, verifies its SHA256 against the release's SHA256SUMS,
# installs vobiz.exe and adds the install directory to your user PATH.
#
# Environment overrides:
#   VOBIZ_VERSION      version to install, e.g. 0.1.0 or v0.1.0 (default: the latest release, resolved once
#                      through the GitHub API and then pinned for every download in this run)
#   VOBIZ_INSTALL_DIR  target directory (default: %LOCALAPPDATA%\Programs\vobiz)
#   VOBIZ_REPO         GitHub repository to download from (default: vobiz-ai/Vobiz-CLI)
#   VOBIZ_REQUIRE_ATTESTATION=1  fail unless the archive's build provenance can be verified with `gh`
#
# Trust model (same as install.sh):
#   - HTTPS only (TLS 1.2+), from github.com and api.github.com.
#   - SHA256SUMS comes from the same release as the archive: it catches corruption and a swapped archive, not a
#     swapped release. Releases are made immutable after publishing (repository setting).
#   - With the GitHub CLI (`gh`) installed and signed in, `gh attestation verify` also checks that the archive was
#     built by this repository's .github/workflows/release.yml from the exact tag on a GitHub-hosted runner; a failure
#     stops the install. Without `gh` it is skipped unless VOBIZ_REQUIRE_ATTESTATION=1.
#   - The whole script is one script block invoked on the last line, so a download cut off mid-way runs nothing.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  function Fail([string]$Message) { Write-Error "vobiz-install: $Message"; exit 1 }

  $Repo = if ($env:VOBIZ_REPO) { $env:VOBIZ_REPO } else { 'vobiz-ai/Vobiz-CLI' }
  $Base = "https://github.com/$Repo"

  $arch = $env:PROCESSOR_ARCHITECTURE
  if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
  switch ($arch) {
    'AMD64' { $cpu = 'x64' }
    # Windows on Arm runs the x64 build under emulation.
    'ARM64' { $cpu = 'x64' }
    default { Fail "unsupported CPU $arch; install with npm instead: npm i -g @vobiz/cli" }
  }

  $version = $env:VOBIZ_VERSION
  if (-not $version) {
    $api = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'vobiz-install' }
    $version = $api.tag_name
    if (-not $version) { Fail 'could not determine the latest release; set VOBIZ_VERSION' }
    Write-Host "vobiz-install: latest release is $version; installing exactly that (set VOBIZ_VERSION to choose another)"
  }
  $version = $version.TrimStart('v')
  if ($version -notmatch '^[0-9A-Za-z.+-]+$') { Fail "invalid VOBIZ_VERSION: $version" }

  $name = "vobiz-$version-win-$cpu"
  $asset = "$name.zip"
  $url = "$Base/releases/download/v$version"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("vobiz-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null

  try {
    Write-Host "vobiz-install: downloading $asset"
    Invoke-WebRequest -UseBasicParsing -Uri "$url/$asset" -OutFile (Join-Path $tmp $asset)
    Invoke-WebRequest -UseBasicParsing -Uri "$url/SHA256SUMS" -OutFile (Join-Path $tmp 'SHA256SUMS')

    $expected = $null
    foreach ($line in Get-Content (Join-Path $tmp 'SHA256SUMS')) {
      $parts = $line -split '\s+', 2
      if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $asset) { $expected = $parts[0].ToLowerInvariant() }
    }
    if (-not $expected) { Fail "$asset is not listed in SHA256SUMS" }
    $actual = (Get-FileHash -Algorithm SHA256 -Path (Join-Path $tmp $asset)).Hash.ToLowerInvariant()
    if ($expected -ne $actual) { Fail "checksum mismatch for $asset (expected $expected, got $actual)" }
    Write-Host 'vobiz-install: checksum verified'

    # Build provenance: optional with `gh`, mandatory with VOBIZ_REQUIRE_ATTESTATION=1.
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    $ghReady = $false
    if ($gh) { & gh auth status *> $null; $ghReady = ($LASTEXITCODE -eq 0) }
    if ($ghReady) {
      & gh attestation verify (Join-Path $tmp $asset) --repo $Repo --signer-workflow "$Repo/.github/workflows/release.yml" --source-ref "refs/tags/v$version" --deny-self-hosted-runners *> $null
      if ($LASTEXITCODE -ne 0) { Fail "gh attestation verify failed for ${asset}: it was not built by ${Repo}'s release workflow from v$version" }
      Write-Host 'vobiz-install: build provenance verified (gh attestation)'
    } elseif ($env:VOBIZ_REQUIRE_ATTESTATION -eq '1') {
      Fail 'VOBIZ_REQUIRE_ATTESTATION=1 needs the GitHub CLI (gh), signed in, to verify the build provenance'
    }

    Expand-Archive -Path (Join-Path $tmp $asset) -DestinationPath $tmp -Force
    $exe = Join-Path (Join-Path $tmp $name) 'vobiz.exe'
    if (-not (Test-Path $exe)) { Fail "the archive does not contain $name\vobiz.exe" }

    $dir = if ($env:VOBIZ_INSTALL_DIR) { $env:VOBIZ_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\vobiz' }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Copy-Item -Force -Path $exe -Destination (Join-Path $dir 'vobiz.exe')
    foreach ($extra in 'completions', 'man') {
      $src = Join-Path (Join-Path $tmp $name) $extra
      if (Test-Path $src) { Copy-Item -Recurse -Force -Path $src -Destination $dir }
    }
    Write-Host "vobiz-install: installed vobiz $version to $dir\vobiz.exe"

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (($userPath -split ';') -contains $dir)) {
      $newPath = if ($userPath) { "$userPath;$dir" } else { $dir }
      [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
      $env:Path = "$env:Path;$dir"
      Write-Host "vobiz-install: added $dir to your user PATH (open a new terminal to pick it up)"
    }
    Write-Host 'vobiz-install: next: run `vobiz login`, then `vobiz --help`.'
  }
  finally {
    Remove-Item -Recurse -Force -Path $tmp -ErrorAction SilentlyContinue
  }
}

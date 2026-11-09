// The short install commands the website shows first:
//
//   Windows PowerShell:  irm https://zero-x.live/install.ps1 | iex
//   Command Prompt:      powershell -ExecutionPolicy Bypass -NoProfile -Command "irm https://zero-x.live/install.ps1 | iex"
//   macOS and Linux:     curl -fsSL https://zero-x.live/install.sh | sh
//
// GET /install.ps1 and GET /install.sh answer a small bootstrap script (text/plain) that fetches the
// installer of one tagged release from GitHub and runs it with that version (and -AddToPath on
// Windows). Not a redirect: every Neuron release so far is a GitHub pre-release, so
// releases/latest/download/... and the API's releases/latest answer 404, and the tagged installer run
// without -Version looks the latest release up and fails. Piped into `iex` or `sh` it cannot be given
// parameters, so the bootstrap passes them.
//
// The release is wrangler.toml [vars] NEURON_INSTALL_VERSION (deploy/aws/gateway-env.mjs copies every
// [vars] entry to the Node server too), so moving the installer to a new release is a one-line change.
// Without it, or with a value that is not a version, the site's release (src/neuron-release.js) is used.
// check-install-route.mjs keeps the two equal, so the pages and the installer name the same build.
import { NEURON_REPOSITORY, NEURON_VERSION } from './neuron-release.js';

export const INSTALL_SCRIPT_PATH = /^\/install\.(ps1|sh)$/;
// Clients and shared caches pick up a new release within this many seconds.
export const INSTALL_SCRIPT_MAX_AGE_SECONDS = 300;
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-[0-9A-Za-z.]{1,32})?$/;

export function installVersion(env) {
  const configured = String(env?.NEURON_INSTALL_VERSION ?? '').trim().replace(/^v/, '');
  return VERSION.test(configured) ? configured : NEURON_VERSION;
}

export const installerUrl = (version, file) =>
  `https://github.com/${NEURON_REPOSITORY}/releases/download/v${version}/${file}`;

// Runs under `irm | iex` in the caller's session (Windows PowerShell 5.1 or PowerShell 7+), so it never
// calls `exit` (that would close the window) and keeps its variables in a child scope. WebClient's
// DownloadString returns text whatever content type GitHub sends (application/octet-stream), in 5.1 and
// in 7, where Invoke-RestMethod may hand back bytes for that type.
export function windowsInstallScript(version) {
  const url = installerUrl(version, 'install.ps1');
  return `# Neuron installer for Windows, served by https://zero-x.live/install.ps1
#
#   PowerShell:      irm https://zero-x.live/install.ps1 | iex
#   Command Prompt:  powershell -ExecutionPolicy Bypass -NoProfile -Command "irm https://zero-x.live/install.ps1 | iex"
#
# Downloads the installer of Neuron ${version} from GitHub Releases and runs it with
# -Version ${version} -AddToPath. It installs neuron.exe and neuron-tui.exe to
# %LOCALAPPDATA%\\Programs\\Neuron\\bin, checks their SHA-256 checksums and adds that folder to your
# user PATH. Set NEURON_NO_TUI=1 first to skip the full-screen UI, or NEURON_INSTALL_DIR to choose
# the folder. The installer itself: ${url}
& {
    $neuronVersion = '${version}'
    $installerUrl = '${url}'
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch { }
    Write-Host "Installing Neuron \${neuronVersion}. Downloading the installer from GitHub ..."
    try {
        $client = New-Object System.Net.WebClient
        $installer = $client.DownloadString($installerUrl)
    } catch {
        Write-Host "error: could not download \${installerUrl}: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host 'Check your internet connection or proxy settings and run the command again.'
        Write-Host 'Help: https://zero-x.live/docs#troubleshooting'
        return
    }
    if ($env:NEURON_NO_TUI -ne '1') {
        Write-Host 'The full-screen UI is a download of more than 100 MB. On a slow connection it can take several minutes.'
    }
    & ([scriptblock]::Create($installer.TrimStart([char]0xFEFF))) -Version $neuronVersion -AddToPath
}
`;
}

// Read whole before anything runs (main is called on the last line), so a cut-off download does nothing.
export function posixInstallScript(version) {
  const url = installerUrl(version, 'install.sh');
  return `#!/bin/sh
# Neuron installer for macOS and Linux, served by https://zero-x.live/install.sh
#
#   curl -fsSL https://zero-x.live/install.sh | sh
#
# Downloads the installer of Neuron ${version} from GitHub Releases and runs it with
# --version ${version}, plus any options given after "sh -s --" (such as --install-dir DIR). It installs neuron and neuron-tui to
# ~/.local/bin and checks their SHA-256 checksums. The installer itself: ${url}
set -eu

main() {
    version='${version}'
    url='${url}'
    echo "Installing Neuron \${version}. Downloading the installer from GitHub ..." >&2
    if command -v curl >/dev/null 2>&1; then
        installer="$(curl -fsSL "$url")" || { echo "error: could not download $url" >&2; exit 1; }
    elif command -v wget >/dev/null 2>&1; then
        installer="$(wget -qO- "$url")" || { echo "error: could not download $url" >&2; exit 1; }
    else
        echo "error: the Neuron installer needs curl or wget" >&2
        exit 1
    fi
    [ "\${NEURON_NO_TUI:-}" = 1 ] || echo "The full-screen UI is a download of more than 100 MB. On a slow connection it can take several minutes." >&2
    printf '%s\\n' "$installer" | sh -s -- --version "$version" "$@"
}

main "$@"
`;
}

// GET (and HEAD) /install.ps1 and /install.sh on every host. src/index.js lets these paths through
// to the API instead of the static files.
export function registerInstallRoutes(api) {
  for (const [path, build] of [['/install.ps1', windowsInstallScript], ['/install.sh', posixInstallScript]]) {
    api.get(path, c => c.body(build(installVersion(c.env)), 200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': `public, max-age=${INSTALL_SCRIPT_MAX_AGE_SECONDS}`,
      'Access-Control-Allow-Origin': '*',
    }));
  }
}

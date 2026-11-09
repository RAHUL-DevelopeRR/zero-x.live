// The Neuron release the website tells people to install: the one place that names it.
// The pages are static HTML, so they repeat these strings; check-neuron-version.mjs (part of
// `npm run check:production`, which CI runs before every deploy) fails when a page, llms.txt,
// a site script, a release manifest or the Worker names another 7.0.0 build, an installer
// command that differs from these, or a pip command without --pre while Neuron 7 is a
// pre-release. To move the site to a new release, change the values below, then update the
// pages until `node check-neuron-version.mjs` and `npm run check:web` pass.
export const NEURON_VERSION = '7.0.0-alpha.5';
// PyPI spells the same pre-release the PEP 440 way.
export const NEURON_PYPI_VERSION = '7.0.0a5';
// As the pages write it (the GitHub release was published on 2026-11-07).
export const NEURON_RELEASE_DATE = '7 November 2026';
export const NEURON_REPOSITORY = 'RAHUL-DevelopeRR/neuron-v2';
export const NEURON_RELEASE_URL = `https://github.com/${NEURON_REPOSITORY}/releases/tag/v${NEURON_VERSION}`;
// A pre-release is never GitHub's "latest" release, and pip skips it unless asked with --pre.
export const NEURON_PRERELEASE = NEURON_VERSION.includes('-');

const DOWNLOAD = `https://github.com/${NEURON_REPOSITORY}/releases/download/v${NEURON_VERSION}`;
// https://zero-x.live/install.ps1 and /install.sh (src/install-scripts.js) run this release's installer
// with its version (and -AddToPath on Windows); NEURON_INSTALL_VERSION in wrangler.toml names it.
const POWERSHELL = 'irm https://zero-x.live/install.ps1 | iex';

// Every install command the site shows, as plain text (escape & as &amp; in HTML), best first.
export const NEURON_INSTALL = Object.freeze({
  // Windows PowerShell 5.1 or PowerShell 7. Works under the default ExecutionPolicy (Restricted):
  // the policy applies to script files, not to text run by iex.
  powershell: POWERSHELL,
  // Command Prompt (cmd.exe): the same command, run by PowerShell.
  cmd: `powershell -ExecutionPolicy Bypass -NoProfile -Command "${POWERSHELL}"`,
  // macOS and Linux (sh, bash, zsh).
  shell: 'curl -fsSL https://zero-x.live/install.sh | sh',
  // Other ways: npm (Node.js) and pip (Python).
  npm: 'npm install -g @zero-x.live/neuron',
  pip: `python -m pip install ${NEURON_PRERELEASE ? '--pre ' : ''}neuroncli`,
  // The same release's installers straight from GitHub, with the version named (a pre-release is
  // never GitHub's latest release). `&` is PowerShell's call operator, which Command Prompt rejects.
  powershellPinned: `& ([scriptblock]::Create((irm ${DOWNLOAD}/install.ps1))) -Version ${NEURON_VERSION} -AddToPath`,
  shellPinned: `curl -fsSL ${DOWNLOAD}/install.sh | sh -s -- --version ${NEURON_VERSION}`,
});

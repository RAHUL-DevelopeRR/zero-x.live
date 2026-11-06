// The Neuron release the website tells people to install: the one place that names it.
// The pages are static HTML, so they repeat these strings; check-neuron-version.mjs (part of
// `npm run check:production`, which CI runs before every deploy) fails when a page, llms.txt,
// a site script, a release manifest or the Worker names another 7.0.0 build, an installer
// command that differs from these, or a pip command without --pre while Neuron 7 is a
// pre-release. To move the site to a new release, change the values below, then update the
// pages until `node check-neuron-version.mjs` and `npm run check:web` pass.
export const NEURON_VERSION = '7.0.0-alpha.4';
// PyPI spells the same pre-release the PEP 440 way.
export const NEURON_PYPI_VERSION = '7.0.0a4';
// As the pages write it (the GitHub release was published on 2026-11-03).
export const NEURON_RELEASE_DATE = '3 November 2026';
export const NEURON_REPOSITORY = 'RAHUL-DevelopeRR/neuron-v2';
export const NEURON_RELEASE_URL = `https://github.com/${NEURON_REPOSITORY}/releases/tag/v${NEURON_VERSION}`;
// A pre-release is never GitHub's "latest" release, and pip skips it unless asked with --pre.
export const NEURON_PRERELEASE = NEURON_VERSION.includes('-');

const DOWNLOAD = `https://github.com/${NEURON_REPOSITORY}/releases/download/v${NEURON_VERSION}`;
const POWERSHELL = `& ([scriptblock]::Create((irm ${DOWNLOAD}/install.ps1))) -Version ${NEURON_VERSION} -AddToPath`;

// Every install command the site shows, as plain text (escape & as &amp; in HTML).
export const NEURON_INSTALL = Object.freeze({
  npm: 'npm install -g @zero-x.live/neuron',
  pip: `python -m pip install ${NEURON_PRERELEASE ? '--pre ' : ''}neuroncli`,
  // macOS and Linux (sh, bash, zsh).
  shell: `curl -fsSL ${DOWNLOAD}/install.sh | sh -s -- --version ${NEURON_VERSION}`,
  // Windows PowerShell 5.1 or PowerShell 7. `&` is PowerShell's call operator, which Command
  // Prompt rejects ("& was unexpected at this time."), hence the separate cmd command.
  powershell: POWERSHELL,
  // Command Prompt (cmd.exe): the same command, run by PowerShell.
  cmd: `powershell -NoProfile -ExecutionPolicy Bypass -Command "${POWERSHELL}"`,
});

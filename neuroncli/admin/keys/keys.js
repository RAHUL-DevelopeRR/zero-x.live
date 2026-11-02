// Provider key vault page (https://dashboard.zero-x.live/admin/keys). It talks only to the
// same-origin key API (neuroncli/auth-server/src/routes/provider-keys.js) with the gateway admin
// token, which stays in this tab's memory. A key is sent once, when it is added; the page never
// receives one back, only labels and last four characters. Every value is written with
// textContent, so a label can never become markup.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const API = '/admin/providers/keys';
  const PROVIDERS = { groq: 'Groq', gemini: 'Gemini', nvidia: 'NVIDIA', openrouter: 'OpenRouter' };
  let token = '';
  let busy = false;

  function say(text, tone = 'info') {
    const message = $('message');
    message.textContent = text;
    message.className = 'zx-alert zx-mb' + (text ? ' zx-alert--' + tone : '');
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      method: options.method || 'GET', body: options.body, cache: 'no-store', credentials: 'same-origin',
      headers: { Authorization: 'Bearer ' + token, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(45000),
    });
    let body = null;
    try { body = await response.json(); } catch { /* not JSON */ }
    return { ok: response.ok, status: response.status, body };
  }

  const errorText = (body, fallback) => (body && body.error && body.error.message) || fallback;
  const failureText = error => error && error.name === 'TimeoutError' ? 'The gateway timed out. Reload the list and try again.'
    : 'The gateway could not be reached. Try again.';
  const when = value => value ? new Date(value).toLocaleString() : '—';

  function cell(row, text, className) {
    const td = document.createElement('td');
    td.textContent = text;
    if (className) td.className = className;
    row.appendChild(td);
    return td;
  }

  function badge(text, tone) {
    const span = document.createElement('span');
    span.className = 'zx-badge' + (tone ? ' zx-badge--' + tone : '');
    span.textContent = text;
    return span;
  }

  // Health of the key's pools (one per model it serves) from the HealthHub.
  function healthBadge(key) {
    const health = key.health;
    if (key.status !== 'active') return badge('—');
    if (!health || !health.pools) return badge('no hosted models');
    const serving = health.pools - health.blurred - health.busy;
    if (!serving) return badge('none serving', 'danger');
    if (serving < health.pools) return badge(serving + ' of ' + health.pools + ' serving', 'warning');
    return badge(health.pools + ' serving', 'success');
  }

  function fallbackText(item) {
    const name = PROVIDERS[item.provider] || item.provider;
    const count = ' (' + item.active_keys + ' of ' + item.max_keys + ' vault keys active)';
    if (!item.env_key) return name + ': no Worker secret, only vault keys serve' + count + '.';
    const secret = item.env_key.variable + ' ••••' + item.env_key.last4;
    return item.env_key.fallback ? name + ': ' + secret + ' serves after the vault keys' + count + '.'
      : name + ': ' + secret + ' is also in the vault, so it serves once, as that key' + count + '.';
  }

  function render(data) {
    const body = $('keys');
    body.replaceChildren();
    for (const key of data.keys) {
      const row = document.createElement('tr');
      cell(row, PROVIDERS[key.provider] || key.provider);
      cell(row, key.label, 'keys-label');
      cell(row, '••••' + key.last4, 'zx-mono');
      cell(row, '').appendChild(badge(key.status, key.status === 'active' ? 'success' : ''));
      cell(row, '').appendChild(healthBadge(key));
      cell(row, when(key.created_at));
      cell(row, when(key.last_used_at));
      const actions = cell(row, '');
      if (key.status === 'active') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'zx-btn zx-btn--danger zx-btn--sm';
        button.textContent = 'Disable';
        button.addEventListener('click', () => disable(key, button));
        actions.appendChild(button);
      }
      body.appendChild(row);
    }
    $('empty').hidden = data.keys.length > 0;
    const list = $('fallback');
    list.replaceChildren();
    for (const item of data.providers) {
      const entry = document.createElement('li');
      entry.textContent = fallbackText(item);
      list.appendChild(entry);
    }
    return data.access_configured ? '' : 'The gateway does not verify Cloudflare Access for this page ' +
      '(CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are unset), so the admin token is the only lock.';
  }

  function lock(text) {
    token = '';
    $('keys').replaceChildren();
    $('vault').hidden = true;
    $('unlock').hidden = false;
    say(text || '');
    $('admin-token').focus();
  }

  // Loads the list; returns the warning to show, or null when it failed (already reported).
  async function refresh() {
    const { ok, status, body } = await api(API);
    if (status === 401) { lock('That admin token was not accepted.'); return null; }
    if (!ok) { say(errorText(body, 'Could not load the keys (HTTP ' + status + ').'), 'error'); return null; }
    return render(body);
  }

  async function unlock(event) {
    event.preventDefault();
    if (busy) return;
    const input = $('admin-token');
    token = input.value.trim();
    input.value = '';
    if (!token) return;
    busy = true;
    $('unlock-button').disabled = true;
    say('Loading…');
    try {
      const warning = await refresh();
      if (warning === null) return;
      $('unlock').hidden = true;
      $('vault').hidden = false;
      say(warning, warning ? 'warning' : 'info');
    } catch (error) {
      token = '';
      say(failureText(error), 'error');
    } finally {
      busy = false;
      $('unlock-button').disabled = false;
    }
  }

  async function add(event) {
    event.preventDefault();
    if (busy) return;
    const keyInput = $('key');
    const provider = $('provider').value;
    const payload = JSON.stringify({ provider, label: $('label').value.trim(), key: keyInput.value.trim() });
    keyInput.value = ''; // the key leaves the page with this request
    busy = true;
    $('add-button').disabled = true;
    say('Checking the key with ' + (PROVIDERS[provider] || provider) + '…');
    try {
      const { ok, status, body } = await api(API, { method: 'POST', body: payload });
      if (status === 401) { lock('The admin token is no longer accepted.'); return; }
      if (!ok) { say(errorText(body, 'The key was not saved (HTTP ' + status + ').'), 'error'); return; }
      $('label').value = '';
      const warning = await refresh();
      if (warning !== null) {
        say('Saved ' + body.key.label + ' (••••' + body.key.last4 + '). Every gateway instance uses it within a minute.', 'success');
      }
    } catch (error) {
      say(failureText(error), 'error');
    } finally {
      busy = false;
      $('add-button').disabled = false;
    }
  }

  async function disable(key, button) {
    if (busy) return;
    if (!window.confirm('Disable ' + key.label + ' (••••' + key.last4 + ')? Its pools stop serving within a minute.')) return;
    busy = true;
    button.disabled = true;
    try {
      const { ok, status, body } = await api(API + '/' + encodeURIComponent(key.id), { method: 'DELETE' });
      if (status === 401) { lock('The admin token is no longer accepted.'); return; }
      if (!ok) { say(errorText(body, 'The key was not disabled (HTTP ' + status + ').'), 'error'); return; }
      const warning = await refresh();
      if (warning !== null) say('Disabled ' + key.label + ' (••••' + key.last4 + ').', 'success');
    } catch (error) {
      say(failureText(error), 'error');
    } finally {
      busy = false;
      button.disabled = false;
    }
  }

  $('unlock').addEventListener('submit', unlock);
  $('add').addEventListener('submit', add);
  $('lock').addEventListener('click', () => lock('Token forgotten.'));
})();

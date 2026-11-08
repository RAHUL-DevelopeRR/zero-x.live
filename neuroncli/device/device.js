// Approval page for `neuron login` device sign-in (docs/PLATFORM_CONTRACT.md section 3.8).
// The code arrives in ?user_code= (verification_uri_complete) or is typed in. Nothing is
// approved without an explicit click, and Approve stays disabled briefly so a click meant for
// something else cannot land on it.
(function () {
  const $ = id => document.getElementById(id);
  const message = $('message');
  const account = $('account');
  const steps = { signin: $('signin-step'), code: $('code-step'), confirm: $('confirm-step') };
  const codeInput = $('code');
  const approve = $('approve');
  const deny = $('deny');
  const switchAccount = $('switch');
  let pendingCode = '';
  let grant = null;
  let busy = false;
  let signedInAs = '';

  const show = name => { for (const [key, el] of Object.entries(steps)) el.hidden = key !== name; };
  const normalize = value => String(value || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8);
  const pretty = code => code.length > 4 ? code.slice(0, 4) + '-' + code.slice(4) : code;
  const errorText = (result, fallback) => result?.error?.message || fallback;

  // The decision is final: the card gives way to a calm full-page result. Focus moves to the
  // headline, which is described by the line and detail, so screen readers read all three.
  // textContent only.
  function finish(title, line, detail) {
    show('none');
    switchAccount.hidden = true;
    message.textContent = '';
    $('card').hidden = true;
    $('result-title').textContent = title;
    $('result-line').textContent = line;
    $('result-detail').textContent = detail || '';
    $('result').hidden = false;
    document.title = title + ' | Zero-X';
    $('result-title').focus();
  }

  function relativeTime(iso) {
    const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (seconds < 60) return seconds + ' seconds ago';
    const minutes = Math.round(seconds / 60);
    return minutes + (minutes === 1 ? ' minute ago' : ' minutes ago');
  }

  async function api(path, body) {
    const token = await window.ZeroXAuth.getAccessToken();
    if (!token) throw Object.assign(new Error('Your sign-in expired. Sign in again.'), { signin: true });
    const response = await fetch(path, {
      method: 'POST', credentials: 'omit',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const result = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, result };
  }

  async function lookup(code) {
    if (busy) return;
    busy = true;
    try {
      message.textContent = 'Looking up the code…';
      const { ok, result } = await api('/auth/device/lookup', { user_code: code });
      if (!ok) { message.textContent = errorText(result, 'That code could not be checked. Try again.'); show('code'); return; }
      grant = result;
      $('confirm-code').textContent = result.user_code;
      const client = result.client || {};
      $('device').textContent = [client.device_name, client.os, client.name && client.version ? client.name + ' ' + client.version : client.name]
        .filter(Boolean).join(' · ') + ' (reported by the device)';
      const where = result.requester || {};
      $('location').textContent = [where.city, where.region, where.country].filter(Boolean).join(', ') +
        (where.ip ? ' · ' + where.ip : '') + (where.network ? ' · ' + where.network : '') || 'Unknown';
      $('when').textContent = relativeTime(result.created_at);
      const mismatch = $('mismatch');
      mismatch.hidden = !(where.country && result.browser_country && where.country !== result.browser_country);
      mismatch.textContent = 'The terminal asking to sign in is in a different country (' + where.country +
        ') from this browser (' + result.browser_country + '). Deny unless you expected that.';
      message.textContent = '';
      show('confirm');
      approve.disabled = true;
      setTimeout(() => { approve.disabled = false; }, 1500);
    } catch (error) {
      if (error.signin) { await render(); return; }
      message.textContent = error.name === 'TimeoutError' ? 'Zero-X timed out. Try again.' : error.message;
    } finally { busy = false; }
  }

  async function decide(decision) {
    if (busy || !grant) return;
    busy = true;
    approve.disabled = true;
    deny.disabled = true;
    try {
      const { ok, result } = await api('/auth/device/approve',
        { grant_id: grant.grant_id, approval_nonce: grant.approval_nonce, decision });
      if (!ok) { message.textContent = errorText(result, 'That did not work. Reload and try again.'); return; }
      if (decision === 'approve') {
        const email = grant.account?.email || signedInAs;
        finish('Neuron is signed in', 'You can close this tab and return to your terminal.', email ? 'Signed in as ' + email : '');
      } else {
        finish('Sign-in denied', 'Nothing was signed in. You can close this tab.');
      }
    } catch (error) {
      message.textContent = error.name === 'TimeoutError' ? 'Zero-X timed out. Try again.' : error.message;
    } finally {
      busy = false;
      deny.disabled = false;
    }
  }

  async function render() {
    const profile = await window.ZeroXAuth.getProfile();
    switchAccount.hidden = !profile;
    if (!profile) {
      account.textContent = '';
      message.textContent = 'Sign in to the Zero-X account you want Neuron to use.';
      show('signin');
      return;
    }
    signedInAs = profile.email || '';
    account.textContent = 'Signed in as ' + (profile.email || profile.fullName || 'your account');
    if (pendingCode.length === 8) { await lookup(pendingCode); return; }
    message.textContent = 'Enter the code shown in your terminal.';
    show('code');
    codeInput.focus();
  }

  async function boot() {
    const params = new URLSearchParams(location.search);
    pendingCode = normalize(params.get('user_code'));
    codeInput.value = pretty(pendingCode);
    if (params.has('user_code')) {
      // Keep the code out of the address bar and history once read. Supabase's own ?code=
      // stays until its SDK has read it.
      params.delete('user_code');
      history.replaceState(null, '', location.pathname + (params.size ? '?' + params : '') + location.hash);
    }
    $('signin').addEventListener('click', () => window.ZeroXAuth.openAuthModal({
      title: 'Sign in to Neuron', subtitle: 'Use your Zero-X account',
      redirectTo: location.origin + location.pathname + (pendingCode ? '?user_code=' + pretty(pendingCode) : ''),
    }));
    // Signs this browser out (other browsers stay signed in) and reloads with the code kept, so
    // the sign-in step, and Google's account chooser, come next. Nothing is approved or denied.
    switchAccount.addEventListener('click', async () => {
      switchAccount.disabled = true;
      try {
        await window.ZeroXAuth.signOut({ scope: 'local',
          redirectUrl: location.origin + location.pathname + (pendingCode ? '?user_code=' + pretty(pendingCode) : '') });
      } catch (error) {
        message.textContent = error.message || 'Sign out failed. Try again.';
        switchAccount.disabled = false;
      }
    });
    codeInput.addEventListener('input', () => { codeInput.value = pretty(normalize(codeInput.value)); });
    $('code-step').addEventListener('submit', event => {
      event.preventDefault();
      pendingCode = normalize(codeInput.value);
      if (pendingCode.length !== 8) { message.textContent = 'The code has 8 letters, like BDWP-HQPK.'; return; }
      lookup(pendingCode);
    });
    approve.addEventListener('click', () => decide('approve'));
    deny.addEventListener('click', () => decide('deny'));
    try {
      if (params.has('error')) throw new Error(params.get('error_description') || 'Sign-in was cancelled.');
      await window.ZeroXAuth.init();
      window.ZeroXAuth.onAuthStateChange(() => { if (!grant) render().catch(error => { message.textContent = error.message; }); });
      await render();
    } catch (error) {
      message.textContent = error.message;
    }
  }
  boot();
})();

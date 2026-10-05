(function () {
  const storageKey = 'neuron-cli-login';
  const button = document.getElementById('connect');
  const message = document.getElementById('message');
  const account = document.getElementById('account');
  let request;
  let signedIn = false;
  let connecting = false;

  function validateRequest(value) {
    const callback = new URL(value.callback_url);
    if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' ||
        !callback.port || callback.username || callback.password ||
        callback.pathname !== '/callback' || callback.search || callback.hash ||
        !/^[A-Za-z0-9_-]{32,256}$/.test(value.state || '')) {
      throw new Error('Invalid terminal callback. Restart neuron auth login in your terminal.');
    }
    return {callback_url: callback.href, state: value.state};
  }

  async function showAccount() {
    const profile = await window.ZeroXAuth.getProfile();
    signedIn = !!profile;
    account.textContent = profile ? profile.email || profile.fullName || 'Signed in' : '';
    message.textContent = profile ? 'Connect this account to the NeuronCLI waiting on this computer.' : 'Sign in to connect your Zero-X account to NeuronCLI.';
    button.textContent = profile ? 'Connect this account' : 'Sign in';
    button.hidden = false;
    button.disabled = connecting;
  }

  async function connect() {
    if (connecting) return;
    connecting = true;
    button.disabled = true;
    try {
      if (!signedIn) {
        await window.ZeroXAuth.openAuthModal({title:'Sign in to NeuronCLI', subtitle:'Use your Zero-X account',
          redirectTo: location.origin + location.pathname + '?' + new URLSearchParams(request)});
        return;
      }
      const accessToken = await window.ZeroXAuth.getAccessToken();
      if (!accessToken) { await showAccount(); throw new Error('Your sign-in expired. Sign in again.'); }
      const response = await fetch('/auth/cli/session', {
        method: 'POST', headers: {'Content-Type':'application/json', Authorization:'Bearer ' + accessToken},
        body: JSON.stringify({version:'neuron-cli-browser'}), signal:AbortSignal.timeout(15000),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || (typeof result.error === 'string' ? result.error : result.error?.message) || 'Could not create a gateway session. Try again.');
      if (!/^ses_[A-Za-z0-9_-]+$/.test(result.session_token || '')) throw new Error('Gateway returned an invalid session. Try again.');
      // Native form navigation keeps the credential out of URLs and avoids loopback CORS.
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = request.callback_url;
      for (const [name, value] of Object.entries({state:request.state, session_token:result.session_token})) {
        const input = document.createElement('input');
        input.type = 'hidden'; input.name = name; input.value = value;
        form.appendChild(input);
      }
      document.body.appendChild(form);
      sessionStorage.removeItem(storageKey);
      message.textContent = 'Returning the gateway session to your terminal…';
      form.submit();
    } catch (error) {
      message.textContent = error.name === 'TimeoutError' ? 'Gateway timed out. Try connecting again.' : error.message;
    } finally { connecting = false; button.disabled = false; }
  }

  async function boot() {
    try {
      const params = new URLSearchParams(location.search);
      if (params.has('callback_url') || params.has('state')) {
        request = validateRequest({callback_url:params.get('callback_url'), state:params.get('state')});
        sessionStorage.setItem(storageKey, JSON.stringify({...request, created:Date.now()}));
        params.delete('callback_url');
        params.delete('state');
        // Supabase must still see its authorization code during SDK initialization.
        history.replaceState(null, '', location.pathname + (params.size ? '?' + params : '') + (location.hash || ''));
      } else {
        const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
        if (!saved || Date.now() - saved.created > 10 * 60 * 1000) throw new Error('This terminal connection expired. Restart neuron auth login.');
        request = validateRequest(saved);
      }
      if (params.has('error')) throw new Error(params.get('error_description') || 'Sign-in was cancelled. Restart neuron auth login.');
      await window.ZeroXAuth.init();
      window.ZeroXAuth.onAuthStateChange(() => { showAccount().catch(error => { message.textContent = error.message; }); });
      button.addEventListener('click', connect);
      await showAccount();
    } catch (error) {
      sessionStorage.removeItem(storageKey);
      message.textContent = error.message;
      button.hidden = true;
    }
  }
  boot();
})();

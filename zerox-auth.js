(function () {
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = new URL('auth.css', document.currentScript.src).href;
  document.head.appendChild(stylesheet);
  const SHARED_STORAGE_KEY = 'zerox-supabase-auth';
  const COOKIE_PART_SUFFIX = '.parts';
  const COOKIE_CHUNK_SIZE = 3500;
  const COOKIE_TTL_SECONDS = 60 * 60 * 24 * 30;

  const state = {
    client: null,
    config: null,
    session: null,
    user: null,
    initPromise: null,
    callbacks: [],
    modal: null,
  };

  function sharedCookieDomain(hostname) {
    if (
      hostname === 'zero-x.live' ||
      hostname === 'www.zero-x.live' ||
      hostname.endsWith('.zero-x.live')
    ) {
      return '.zero-x.live';
    }
    return '';
  }

  function cookieAttributes(maxAgeSeconds) {
    const attrs = ['Path=/', 'SameSite=Lax'];
    const domain = sharedCookieDomain(window.location.hostname);
    if (domain) attrs.push('Domain=' + domain);
    if (window.location.protocol === 'https:') attrs.push('Secure');
    if (typeof maxAgeSeconds === 'number') attrs.push('Max-Age=' + Math.max(0, maxAgeSeconds));
    return '; ' + attrs.join('; ');
  }

  function readCookie(name) {
    const encodedName = encodeURIComponent(name) + '=';
    const cookies = document.cookie ? document.cookie.split('; ') : [];
    for (const cookie of cookies) {
      if (cookie.indexOf(encodedName) === 0) {
        return decodeURIComponent(cookie.slice(encodedName.length));
      }
    }
    return null;
  }

  function writeCookie(name, value, maxAgeSeconds) {
    document.cookie =
      encodeURIComponent(name) +
      '=' +
      encodeURIComponent(value) +
      cookieAttributes(maxAgeSeconds);
  }

  function deleteCookie(name) {
    document.cookie =
      encodeURIComponent(name) +
      '=; Path=/; Max-Age=0; SameSite=Lax' +
      (window.location.protocol === 'https:' ? '; Secure' : '');
    const domain = sharedCookieDomain(window.location.hostname);
    if (domain) {
      document.cookie =
        encodeURIComponent(name) +
        '=; Path=/; Domain=' +
        domain +
        '; Max-Age=0; SameSite=Lax' +
        (window.location.protocol === 'https:' ? '; Secure' : '');
    }
  }

  function splitValue(value) {
    const parts = [];
    let part = '', encodedSize = 0;
    for (const character of value) {
      const size = encodeURIComponent(character).length;
      if (encodedSize + size > COOKIE_CHUNK_SIZE) {
        parts.push(part);
        part = '';
        encodedSize = 0;
      }
      part += character;
      encodedSize += size;
    }
    parts.push(part);
    return parts;
  }

  const sharedCookieStorage = {
    getItem(key) {
      const partCount = parseInt(readCookie(key + COOKIE_PART_SUFFIX) || '0', 10);
      if (!partCount) {
        return readCookie(key);
      }
      let value = '';
      for (let i = 0; i < partCount; i += 1) {
        value += readCookie(key + '.' + i) || '';
      }
      return value || null;
    },
    setItem(key, value) {
      sharedCookieStorage.removeItem(key);
      const parts = splitValue(String(value));
      writeCookie(key + COOKIE_PART_SUFFIX, String(parts.length), COOKIE_TTL_SECONDS);
      parts.forEach(function (part, index) {
        writeCookie(key + '.' + index, part, COOKIE_TTL_SECONDS);
      });
    },
    removeItem(key) {
      const partCount = parseInt(readCookie(key + COOKIE_PART_SUFFIX) || '0', 10);
      deleteCookie(key);
      deleteCookie(key + COOKIE_PART_SUFFIX);
      for (let i = 0; i < partCount; i += 1) {
        deleteCookie(key + '.' + i);
      }
    },
  };

  function normalizeProviders(providers) {
    if (!providers) return [];
    if (Array.isArray(providers)) return providers.filter(Boolean);
    return String(providers)
      .split(',')
      .map(function (value) {
        return value.trim();
      })
      .filter(Boolean);
  }

  function titleCase(value) {
    return String(value || '')
      .split(/[\s_-]+/)
      .filter(Boolean)
      .map(function (part) {
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join(' ');
  }

  function safeValue(value) {
    return value == null ? '' : String(value);
  }

  function escapeHtml(value) {
    return safeValue(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function firstNonEmpty(values) {
    for (const value of values) {
      if (value == null) continue;
      const text = String(value).trim();
      if (text) return text;
    }
    return '';
  }

  function splitName(fullName) {
    const parts = String(fullName || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return { firstName: '', lastName: '' };
    if (parts.length === 1) return { firstName: parts[0], lastName: '' };
    return {
      firstName: parts[0],
      lastName: parts.slice(1).join(' '),
    };
  }

  function getUserMetadata(user) {
    return (user && user.user_metadata) || {};
  }

  function getAppMetadata(user) {
    return (user && user.app_metadata) || {};
  }

  function getIdentityAvatar(user) {
    const metadata = getUserMetadata(user);
    const identities = Array.isArray(user && user.identities) ? user.identities : [];
    const identityData = identities[0] && identities[0].identity_data ? identities[0].identity_data : {};
    return firstNonEmpty([
      metadata.avatar_url,
      metadata.picture,
      identityData.avatar_url,
      identityData.picture,
    ]);
  }

  function getIdentityUsername(user) {
    const metadata = getUserMetadata(user);
    const identities = Array.isArray(user && user.identities) ? user.identities : [];
    const identityData = identities[0] && identities[0].identity_data ? identities[0].identity_data : {};
    return firstNonEmpty([
      metadata.user_name,
      metadata.username,
      metadata.preferred_username,
      identityData.user_name,
      identityData.preferred_username,
      identityData.nickname,
    ]);
  }

  function buildProfile(user) {
    if (!user) return null;
    const metadata = getUserMetadata(user);
    const fullName = firstNonEmpty([
      metadata.full_name,
      metadata.name,
      [metadata.first_name, metadata.last_name].filter(Boolean).join(' '),
      [metadata.given_name, metadata.family_name].filter(Boolean).join(' '),
    ]);
    const nameParts = splitName(fullName);
    const email = firstNonEmpty([user.email, metadata.email]);
    const providers = normalizeProviders(
      getAppMetadata(user).providers || getAppMetadata(user).provider || []
    );
    const displayName = firstNonEmpty([
      fullName,
      getIdentityUsername(user),
      email ? email.split('@')[0] : '',
      user.phone,
      'Developer',
    ]);

    return {
      id: safeValue(user.id),
      email: safeValue(email),
      firstName: safeValue(firstNonEmpty([metadata.first_name, metadata.given_name, nameParts.firstName])),
      lastName: safeValue(firstNonEmpty([metadata.last_name, metadata.family_name, nameParts.lastName])),
      fullName: safeValue(displayName),
      username: safeValue(getIdentityUsername(user)),
      imageUrl: safeValue(getIdentityAvatar(user)),
      providers: providers,
      providersDisplay: providers.length
        ? providers.map(function (provider) { return titleCase(provider); }).join(', ')
        : 'Email',
      createdAt: safeValue(user.created_at),
      raw: user,
    };
  }

  function notifyAuthChange(eventName) {
    const profile = buildProfile(state.user);
    state.callbacks.forEach(function (callback) {
      try {
        callback({
          event: eventName,
          session: state.session,
          user: state.user,
          profile: profile,
        });
      } catch (err) {
        console.error('Auth change callback failed:', err);
      }
    });
  }

  async function fetchAuthConfig() {
    const response = await fetch('/auth/config', {
      headers: {
        Accept: 'application/json',
      },
    });
    const data = await response.json().catch(function () {
      return {};
    });
    if (!response.ok) {
      throw new Error(data.message || data.error || 'Failed to load authentication config.');
    }
    return data;
  }

  async function refreshState() {
    if (!state.client) {
      state.session = null;
      state.user = null;
      return null;
    }

    const sessionResult = await state.client.auth.getSession();
    state.session = sessionResult.data ? sessionResult.data.session : null;
    if (!state.session) {
      state.user = null;
      return null;
    }

    const userResult = await state.client.auth.getUser();
    if (userResult.error) {
      throw userResult.error;
    }

    state.user = (userResult.data && userResult.data.user) || state.session.user || null;
    return state.user;
  }

  async function init() {
    if (state.initPromise) return state.initPromise;

    state.initPromise = (async function () {
      if (!window.supabase || !window.supabase.createClient) {
        throw new Error('Supabase JS SDK did not load.');
      }

      state.config = await fetchAuthConfig();
      state.config.providers = normalizeProviders(state.config.providers);

      if (state.config.configured) {
        state.client = window.supabase.createClient(
          state.config.supabase_url,
          state.config.supabase_key,
          {
            auth: {
              flowType: 'pkce',
              autoRefreshToken: true,
              persistSession: true,
              detectSessionInUrl: true,
              storage: sharedCookieStorage,
              storageKey: state.config.storage_key || SHARED_STORAGE_KEY,
            },
          }
        );

        state.client.auth.onAuthStateChange(function (eventName, session) {
          state.session = session || null;
          state.user = session && session.user ? session.user : null;
          notifyAuthChange(eventName);
        });

        await refreshState();
      }

      return {
        configured: !!state.config.configured,
      };
    })().catch(function (error) {
      state.initPromise = null;
      throw error;
    });

    return state.initPromise;
  }

  async function requireConfiguredClient() {
    await init();
    if (!state.config || !state.config.configured || !state.client) {
      throw new Error('Supabase authentication is not configured for this environment.');
    }
    return state.client;
  }

  function redirectTarget() {
    return window.location.origin + window.location.pathname;
  }

  function ensureModal(options) {
    const title = options && options.title ? options.title : 'Sign in';
    const subtitle = options && options.subtitle ? options.subtitle : 'Continue with your ZeroX account';
    const providers = state.config?.providers || [];

    if (!state.modal) {
      const modal = document.createElement('dialog');
      modal.setAttribute('data-zerox-auth-modal', 'true');
      modal.setAttribute('aria-labelledby', 'zerox-auth-title');
      modal.setAttribute('aria-describedby', 'zerox-auth-subtitle');
      modal.className = 'zerox-auth';
      modal.style.cssText =
        'width:min(460px,calc(100% - 32px));max-height:calc(100dvh - 32px);overflow:auto;' +
        'margin:auto;background:#111114;color:#fff;border:1px solid #686877;border-radius:16px;padding:28px;';

      modal.innerHTML =
        '<div>' +
          '<button type="button" aria-label="Close sign-in" data-auth-close="true" style="position:absolute;top:12px;right:12px;background:none;border:none;color:#A6A6B2;font-size:24px;cursor:pointer;min-width:44px;min-height:44px">×</button>' +
          '<h2 id="zerox-auth-title" style="font-size:28px;font-weight:700;color:#fff;padding-right:28px" data-auth-title="true"></h2>' +
          '<p id="zerox-auth-subtitle" style="font-size:14px;color:#A6A6B2;margin-top:6px;margin-bottom:22px" data-auth-subtitle="true"></p>' +
          '<div role="status" aria-live="polite" data-auth-message="true" style="display:none;margin-bottom:16px;padding:12px 14px;border-radius:12px;font-size:13px"></div>' +
          '<div data-auth-providers="true" style="display:flex;flex-direction:column;gap:10px"></div>' +
          '<form data-auth-email-wrap="true" hidden style="margin-top:20px">' +
            '<label for="zerox-auth-email">Email address</label>' +
            '<input id="zerox-auth-email" type="email" autocomplete="email" required placeholder="you@company.com"/>' +
            '<button type="submit" data-auth-email-submit="true">Email me a sign-in link</button>' +
          '</form>' +
          '<form data-auth-phone-wrap="true" hidden style="margin-top:20px">' +
            '<label for="zerox-auth-phone">Phone number with country code</label>' +
            '<input id="zerox-auth-phone" type="tel" autocomplete="tel" required pattern="\\+[1-9][0-9]{7,14}" placeholder="+91..."/>' +
            '<button type="submit" data-auth-phone-submit="true">Send SMS code</button>' +
          '</form>' +
          '<form data-auth-verify-wrap="true" hidden style="margin-top:20px">' +
            '<label for="zerox-auth-code">SMS verification code</label>' +
            '<input id="zerox-auth-code" inputmode="numeric" autocomplete="one-time-code" required pattern="[0-9]{6}" maxlength="6"/>' +
            '<button type="submit">Verify and sign in</button>' +
          '</form>' +
        '</div>';

      modal.addEventListener('click', function (event) {
        if (event.target.closest('[data-auth-close="true"]')) {
          closeAuthModal();
        }
      });

      document.body.appendChild(modal);
      state.modal = modal;
    }

    const titleEl = state.modal.querySelector('[data-auth-title="true"]');
    const subtitleEl = state.modal.querySelector('[data-auth-subtitle="true"]');
    const providersEl = state.modal.querySelector('[data-auth-providers="true"]');
    const emailWrap = state.modal.querySelector('[data-auth-email-wrap="true"]');
    const emailInput = state.modal.querySelector('#zerox-auth-email');
    const emailSubmit = state.modal.querySelector('[data-auth-email-submit="true"]');
    const phoneWrap = state.modal.querySelector('[data-auth-phone-wrap="true"]');
    const verifyWrap = state.modal.querySelector('[data-auth-verify-wrap="true"]');

    titleEl.textContent = title;
    subtitleEl.textContent = subtitle;
    providersEl.innerHTML = '';

    providers
      .filter(function (provider) {
        return provider !== 'email' && provider !== 'phone';
      })
      .forEach(function (provider) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Continue with ' + ({ azure: 'Microsoft', github: 'GitHub' }[provider] || titleCase(provider));
        button.style.cssText =
          'width:100%;background:#17171B;color:#fff;border:1px solid rgba(255,255,255,0.08);' +
          'border-radius:14px;padding:13px 16px;font-size:14px;font-weight:600;cursor:pointer;' +
          'transition:background .15s ease,border-color .15s ease;';
        button.addEventListener('mouseenter', function () {
          button.style.background = '#1D1D22';
          button.style.borderColor = 'rgba(0,229,255,0.25)';
        });
        button.addEventListener('mouseleave', function () {
          button.style.background = '#17171B';
          button.style.borderColor = 'rgba(255,255,255,0.08)';
        });
        button.addEventListener('click', async function () {
          await runAuthAction(button, () => signInWithOAuth(provider));
        });
        providersEl.appendChild(button);
      });

    if (providers.indexOf('email') !== -1) {
      emailWrap.hidden = false;
      emailWrap.onsubmit = async function (event) {
        event.preventDefault();
        await runAuthAction(emailSubmit, () => signInWithEmail(emailInput.value));
      };
    } else {
      emailWrap.hidden = true;
    }
    phoneWrap.hidden = !providers.includes('phone');
    verifyWrap.hidden = true;
    state.pendingPhone = null;
    state.modal.querySelector('#zerox-auth-code').value = '';
    phoneWrap.onsubmit = async function (event) {
      event.preventDefault();
      await runAuthAction(phoneWrap.querySelector('button'), async () => {
        const phone = state.modal.querySelector('#zerox-auth-phone').value.trim();
        if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error('Enter your phone number with its country code.');
        const client = await requireConfiguredClient();
        const result = await client.auth.signInWithOtp({ phone });
        if (result.error) throw result.error;
        state.pendingPhone = phone;
        verifyWrap.hidden = false;
        setModalMessage('SMS sent. Enter the verification code.', 'success');
        state.modal.querySelector('#zerox-auth-code').focus();
      });
    };
    verifyWrap.onsubmit = async function (event) {
      event.preventDefault();
      await runAuthAction(verifyWrap.querySelector('button'), async () => {
        const token = state.modal.querySelector('#zerox-auth-code').value.trim();
        if (!state.pendingPhone || !/^\d{6}$/.test(token)) throw new Error('Enter the six-digit code from your SMS.');
        const client = await requireConfiguredClient();
        const result = await client.auth.verifyOtp({ phone: state.pendingPhone, token, type: 'sms' });
        if (result.error) throw result.error;
        window.location.reload();
      });
    };

    return state.modal;
  }

  async function runAuthAction(button, action) {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Please wait...';
    setModalMessage('');
    try { await action(); }
    catch (error) { setModalMessage(error.message || 'Sign-in failed. Please try again.'); }
    finally { button.disabled = false; button.textContent = label; }
  }

  function setModalMessage(message, tone) {
    if (!state.modal) return;
    const messageEl = state.modal.querySelector('[data-auth-message="true"]');
    if (!message) {
      messageEl.style.display = 'none';
      messageEl.textContent = '';
      return;
    }
    messageEl.style.display = 'block';
    messageEl.textContent = message;
    if (tone === 'success') {
      messageEl.style.background = 'rgba(52,211,153,0.12)';
      messageEl.style.border = '1px solid rgba(52,211,153,0.25)';
      messageEl.style.color = '#86efac';
      return;
    }
    messageEl.style.background = 'rgba(248,113,113,0.12)';
    messageEl.style.border = '1px solid rgba(248,113,113,0.25)';
    messageEl.style.color = '#fca5a5';
  }

  async function signInWithOAuth(provider) {
    const client = await requireConfiguredClient();
    setModalMessage('');
    const result = await client.auth.signInWithOAuth({
      provider: provider,
      options: {
        redirectTo: redirectTarget(),
        ...(provider === 'azure' ? { scopes: 'email' } : {}),
      },
    });
    if (result.error) {
      setModalMessage(result.error.message || 'Unable to start sign-in.');
      throw result.error;
    }
  }

  async function signInWithEmail(email) {
    const client = await requireConfiguredClient();
    const trimmedEmail = String(email || '').trim();
    if (!trimmedEmail) {
      setModalMessage('Enter an email address to receive a magic link.');
      return;
    }
    setModalMessage('');
    const result = await client.auth.signInWithOtp({
      email: trimmedEmail,
      options: {
        emailRedirectTo: redirectTarget(),
        shouldCreateUser: true,
      },
    });
    if (result.error) {
      setModalMessage(result.error.message || 'Unable to send magic link.');
      throw result.error;
    }
    setModalMessage('Magic link sent. Check your inbox and return here after signing in.', 'success');
  }

  async function openAuthModal(options) {
    let error;
    try { await init(); } catch (failure) { error = failure; }
    ensureModal(options);
    setModalMessage('');
    if (!state.modal.open) state.modal.showModal();
    if (error || !state.config?.configured) {
      setModalMessage('Sign-in is temporarily unavailable. Downloads do not require an account. Please try again later.');
    } else if (!state.config.providers.length) {
      setModalMessage('No sign-in method is currently available. Please try again later.');
    }
  }

  function closeAuthModal() {
    if (state.modal) {
      state.modal.close();
    }
  }

  function initialsForProfile(profile) {
    const source = firstNonEmpty([profile.firstName, profile.fullName, profile.email]);
    const parts = String(source).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return 'ZX';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
  }

  function renderAvatar(profile, size) {
    const dimension = size || 32;
    if (profile.imageUrl) {
      return (
        '<img src="' +
        escapeHtml(/^https?:\/\//.test(profile.imageUrl) ? profile.imageUrl : '') +
        '" alt="" style="width:' +
        dimension +
        'px;height:' +
        dimension +
        'px;border-radius:999px;object-fit:cover;display:block"/>'
      );
    }
    return (
      '<div style="width:' +
      dimension +
      'px;height:' +
      dimension +
      'px;border-radius:999px;background:rgba(0,229,255,0.18);color:#00E5FF;' +
      'display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;letter-spacing:.04em">' +
      escapeHtml(initialsForProfile(profile)) +
      '</div>'
    );
  }

  function mountUserButton(container, options) {
    const profile = buildProfile(state.user);
    if (!container) return;
    if (!profile) {
      container.innerHTML = '';
      return;
    }

    const afterSignOutUrl = options && options.afterSignOutUrl ? options.afterSignOutUrl : window.location.href;
    container.innerHTML =
      '<div style="position:relative">' +
        '<button type="button" aria-label="Open account menu" aria-expanded="false" data-auth-user-trigger="true" style="display:flex;align-items:center;gap:10px;background:none;border:none;color:#E8E8EC;cursor:pointer;padding:0;min-width:44px;min-height:44px">' +
          renderAvatar(profile, 34) +
        '</button>' +
        '<div data-auth-user-menu="true" style="display:none;position:absolute;top:44px;right:0;width:240px;background:#111114;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:14px;box-shadow:0 30px 80px rgba(0,0,0,0.45);z-index:100">' +
          '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">' +
            renderAvatar(profile, 40) +
            '<div style="min-width:0">' +
              '<div style="font-size:14px;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(profile.fullName) + '</div>' +
              '<div style="font-size:12px;color:#A6A6B2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(profile.email || state.user?.phone || 'Signed in') + '</div>' +
            '</div>' +
          '</div>' +
          '<button type="button" data-auth-user-signout="true" style="width:100%;background:none;border:1px solid rgba(248,113,113,0.25);color:#f87171;border-radius:12px;padding:10px 12px;font-size:13px;font-weight:600;cursor:pointer">Sign Out</button>' +
        '</div>' +
      '</div>';

    const trigger = container.querySelector('[data-auth-user-trigger="true"]');
    const menu = container.querySelector('[data-auth-user-menu="true"]');
    const signOutButton = container.querySelector('[data-auth-user-signout="true"]');

    function closeMenu() {
      menu.style.display = 'none';
      trigger.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', closeMenuOnOutsideClick);
    }

    container.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { closeMenu(); trigger.focus(); }
    });

    function closeMenuOnOutsideClick(event) {
      if (!container.contains(event.target)) {
        closeMenu();
      }
    }

    trigger.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      const isOpen = menu.style.display === 'block';
      menu.style.display = isOpen ? 'none' : 'block';
      trigger.setAttribute('aria-expanded', String(!isOpen));
      if (!isOpen) {
        setTimeout(function () {
          document.addEventListener('click', closeMenuOnOutsideClick);
        }, 0);
      } else {
        document.removeEventListener('click', closeMenuOnOutsideClick);
      }
    });

    signOutButton.addEventListener('click', async function () {
      await signOut({ redirectUrl: afterSignOutUrl });
    });
  }

  async function signOut(options) {
    if (state.client) {
      const result = await state.client.auth.signOut();
      if (result.error) {
        throw result.error;
      }
    }
    state.session = null;
    state.user = null;
    closeAuthModal();
    notifyAuthChange('SIGNED_OUT');
    const redirectUrl = options && options.redirectUrl ? options.redirectUrl : window.location.href;
    window.location.href = redirectUrl;
  }

  async function getUser() {
    await init();
    return state.user;
  }

  async function getProfile(user) {
    await init();
    return buildProfile(user || state.user);
  }

  async function getAccessToken() {
    await init();
    if (!state.client) return '';
    const sessionResult = await state.client.auth.getSession();
    state.session = sessionResult.data ? sessionResult.data.session : null;
    if (state.session && state.session.user) {
      state.user = state.session.user;
    }
    return state.session ? state.session.access_token || '' : '';
  }

  function onAuthStateChange(callback) {
    state.callbacks.push(callback);
    return function () {
      const index = state.callbacks.indexOf(callback);
      if (index !== -1) state.callbacks.splice(index, 1);
    };
  }

  window.ZeroXAuth = {
    init: init,
    getUser: getUser,
    getProfile: getProfile,
    getAccessToken: getAccessToken,
    openAuthModal: openAuthModal,
    closeAuthModal: closeAuthModal,
    mountUserButton: mountUserButton,
    signOut: signOut,
    onAuthStateChange: onAuthStateChange,
  };
})();

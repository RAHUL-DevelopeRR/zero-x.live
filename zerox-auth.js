(function () {
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
    for (let i = 0; i < value.length; i += COOKIE_CHUNK_SIZE) {
      parts.push(value.slice(i, i + COOKIE_CHUNK_SIZE));
    }
    return parts.length ? parts : [''];
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
      state.config.providers = normalizeProviders(state.config.providers || 'google,github,email');

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

        state.client.auth.onAuthStateChange(async function (eventName, session) {
          state.session = session || null;
          state.user = session && session.user ? session.user : null;
          if (state.session) {
            try {
              const userResult = await state.client.auth.getUser();
              if (!userResult.error && userResult.data) {
                state.user = userResult.data.user || state.user;
              }
            } catch (err) {
              console.warn('Auth refresh warning:', err.message);
            }
          }
          notifyAuthChange(eventName);
        });

        await refreshState();
      }

      return {
        configured: !!state.config.configured,
      };
    })();

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
    return window.location.origin + window.location.pathname + window.location.search;
  }

  function ensureModal(options) {
    const title = options && options.title ? options.title : 'Sign in';
    const subtitle = options && options.subtitle ? options.subtitle : 'Continue with your ZeroX account';
    const providers = state.config && state.config.providers ? state.config.providers : ['google', 'github', 'email'];

    if (!state.modal) {
      const modal = document.createElement('div');
      modal.setAttribute('data-zerox-auth-modal', 'true');
      modal.style.cssText =
        'position:fixed;inset:0;display:none;align-items:center;justify-content:center;' +
        'background:rgba(10,10,12,0.82);backdrop-filter:blur(18px);z-index:2147483647;padding:20px;';

      modal.innerHTML =
        '<div style="width:min(460px,100%);background:#111114;border:1px solid rgba(255,255,255,0.08);' +
        'border-radius:20px;padding:28px;box-shadow:0 40px 120px rgba(0,0,0,0.45);position:relative">' +
          '<button type="button" data-auth-close="true" style="position:absolute;top:16px;right:16px;background:none;border:none;color:#8A8A96;font-size:24px;cursor:pointer;line-height:1">×</button>' +
          '<div style="font-family:\'Cabinet Grotesk\',sans-serif;font-size:28px;font-weight:700;color:#fff" data-auth-title="true"></div>' +
          '<p style="font-size:14px;color:#8A8A96;margin-top:6px;margin-bottom:22px" data-auth-subtitle="true"></p>' +
          '<div data-auth-message="true" style="display:none;margin-bottom:16px;padding:12px 14px;border-radius:12px;font-size:13px"></div>' +
          '<div data-auth-providers="true" style="display:flex;flex-direction:column;gap:10px"></div>' +
          '<div data-auth-email-wrap="true" style="margin-top:16px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.06);display:none">' +
            '<label for="zerox-auth-email" style="display:block;font-size:12px;color:#8A8A96;margin-bottom:8px">Email magic link</label>' +
            '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
              '<input id="zerox-auth-email" type="email" placeholder="you@company.com" style="flex:1;min-width:180px;background:#0A0A0C;border:1px solid rgba(255,255,255,0.08);color:#fff;border-radius:12px;padding:12px 14px;font-size:14px;outline:none"/>' +
              '<button type="button" data-auth-email-submit="true" style="background:#00E5FF;color:#0A0A0C;border:none;border-radius:12px;padding:12px 16px;font-size:13px;font-weight:700;cursor:pointer">Send Link</button>' +
            '</div>' +
          '</div>' +
        '</div>';

      modal.addEventListener('click', function (event) {
        if (event.target === modal || event.target.getAttribute('data-auth-close') === 'true') {
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

    titleEl.textContent = title;
    subtitleEl.textContent = subtitle;
    providersEl.innerHTML = '';

    providers
      .filter(function (provider) {
        return provider !== 'email';
      })
      .forEach(function (provider) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Continue with ' + titleCase(provider);
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
          await signInWithOAuth(provider);
        });
        providersEl.appendChild(button);
      });

    if (providers.indexOf('email') !== -1) {
      emailWrap.style.display = 'block';
      emailSubmit.onclick = async function () {
        await signInWithEmail(emailInput.value);
      };
    } else {
      emailWrap.style.display = 'none';
    }

    return state.modal;
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
    await init();
    if (!state.config || !state.config.configured) {
      throw new Error('Supabase authentication is not configured for this environment.');
    }
    ensureModal(options);
    setModalMessage('');
    state.modal.style.display = 'flex';
  }

  function closeAuthModal() {
    if (state.modal) {
      state.modal.style.display = 'none';
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
        profile.imageUrl +
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
      initialsForProfile(profile) +
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
        '<button type="button" data-auth-user-trigger="true" style="display:flex;align-items:center;gap:10px;background:none;border:none;color:#E8E8EC;cursor:pointer;padding:0">' +
          renderAvatar(profile, 34) +
        '</button>' +
        '<div data-auth-user-menu="true" style="display:none;position:absolute;top:44px;right:0;width:240px;background:#111114;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:14px;box-shadow:0 30px 80px rgba(0,0,0,0.45);z-index:100">' +
          '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">' +
            renderAvatar(profile, 40) +
            '<div style="min-width:0">' +
              '<div style="font-size:14px;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + profile.fullName + '</div>' +
              '<div style="font-size:12px;color:#8A8A96;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + (profile.email || 'Signed in') + '</div>' +
            '</div>' +
          '</div>' +
          '<button type="button" data-auth-user-signout="true" style="width:100%;background:none;border:1px solid rgba(248,113,113,0.25);color:#f87171;border-radius:12px;padding:10px 12px;font-size:13px;font-weight:600;cursor:pointer">Sign Out</button>' +
        '</div>' +
      '</div>';

    const trigger = container.querySelector('[data-auth-user-trigger="true"]');
    const menu = container.querySelector('[data-auth-user-menu="true"]');
    const signOutButton = container.querySelector('[data-auth-user-signout="true"]');

    function closeMenuOnOutsideClick(event) {
      if (!container.contains(event.target)) {
        menu.style.display = 'none';
        document.removeEventListener('click', closeMenuOnOutsideClick);
      }
    }

    trigger.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      const isOpen = menu.style.display === 'block';
      menu.style.display = isOpen ? 'none' : 'block';
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

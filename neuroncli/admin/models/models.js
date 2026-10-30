// Model catalog page (https://dashboard.zero-x.live/admin/models). It talks only to the
// same-origin catalog API (neuroncli/auth-server/src/routes/catalog-admin.js) with the gateway
// admin token, which stays in this tab's memory and is never written to storage. Every value from
// the API is written with textContent, so a display name or a note can never become markup.
// Approve sends the revision that was reviewed and the active revision it was compared with, so
// the gateway refuses it (stale_revision) if either changed in between.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const API = '/admin/catalog';
  let token = '';
  let busy = false;
  let types = [];
  let current = null; // the model shown in the detail panel (catalog-admin modelView)
  let editing = null; // { id, long_context } while the editor proposes a change to an existing model

  function say(text, tone = 'info') {
    const message = $('message');
    message.textContent = text;
    message.className = 'zx-alert zx-mb' + (text ? ' zx-alert--' + tone : '');
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      method: options.method || 'GET', body: options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store', credentials: 'same-origin',
      headers: { Authorization: 'Bearer ' + token, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(45000),
    });
    let body = null;
    try { body = await response.json(); } catch { /* not JSON */ }
    if (response.status === 401) lock('The admin token is not accepted.');
    return { ok: response.ok, status: response.status, body };
  }

  const errorText = (body, fallback) => (body && body.error && body.error.message) || fallback;
  const failureText = error => error && error.name === 'TimeoutError' ? 'The gateway timed out. Try again.'
    : 'The gateway could not be reached. Try again.';
  const when = value => value ? new Date(value).toLocaleString() : '—';
  const show = value => value === null || value === undefined || value === '' ? '—'
    : typeof value === 'object' ? JSON.stringify(value) : String(value);

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined && text !== null) element.textContent = String(text);
    if (className) element.className = className;
    return element;
  }

  function cell(row, text, className) {
    const td = node('td', text, className);
    row.appendChild(td);
    return td;
  }

  function badge(text, tone) {
    return node('span', text, 'zx-badge' + (tone ? ' zx-badge--' + tone : ''));
  }

  function button(text, className, onClick) {
    const element = node('button', text, 'zx-btn zx-btn--sm ' + (className || ''));
    element.type = 'button';
    element.addEventListener('click', onClick);
    return element;
  }

  function fillList(id, lines, className) {
    const list = $(id);
    list.replaceChildren();
    for (const line of lines) list.appendChild(node('li', line, className));
  }

  function fillSpec(id, pairs) {
    const list = $(id);
    list.replaceChildren();
    for (const [term, value] of pairs) {
      list.appendChild(node('dt', term));
      list.appendChild(node('dd', show(value)));
    }
  }

  function reasonLines(validation) {
    if (!validation) return [];
    const lines = validation.model.map(reason => 'Model: ' + reason);
    for (const [tier, reasons] of Object.entries(validation.pools || {})) {
      for (const reason of reasons) lines.push(tier + ' pool: ' + reason);
    }
    return lines;
  }

  function specPairs(spec, preview) {
    if (!spec) return [['Revision', 'none (served from code or not at all)']];
    const pairs = [['Upstream', spec.provider_type + ' ' + spec.upstream_model], ['Name', spec.display_name],
      ['Context / output', spec.context_window + ' / ' + spec.max_output_tokens],
      ['Default max_tokens', spec.default_max_tokens], ['Efforts', (spec.reasoning_efforts || []).join(', ')],
      ['Default effort', spec.default_reasoning_effort], ['Aliases', (spec.aliases || []).join(', ')],
      ['Auto rank', spec.auto_rank], ['Position', spec.position]];
    for (const pool of spec.pools || []) {
      const price = pool.price ? ['input ' + pool.price.input_usd_per_mtok, 'output ' + pool.price.output_usd_per_mtok,
        pool.price.cache_read_usd_per_mtok !== null ? 'cache read ' + pool.price.cache_read_usd_per_mtok : null,
        pool.price.cache_write_usd_per_mtok !== null ? 'cache write ' + pool.price.cache_write_usd_per_mtok : null]
        .filter(Boolean).join(', ') + ' $/Mtok' : 'free';
      pairs.push([pool.tier + ' pool', pool.key_slot + '; ' + price +
        (pool.daily_spend_cap_usd !== null ? '; cap $' + pool.daily_spend_cap_usd + '/day' : '')]);
    }
    if (preview && preview.pricing) pairs.push(['Users pay', show(preview.pricing)]);
    return pairs;
  }

  // ── List ──

  function statusBadge(model) {
    const tone = { active: 'success', draft: 'warning', disabled: 'danger' }[model.status] || '';
    return badge(model.status, tone);
  }

  function render(data) {
    const status = data.catalog;
    $('catalog-status').textContent = 'Serving the ' + status.source + ' catalog, version ' + status.version +
      (status.failing ? ' (the database is not answering: last good catalog)' : '') + '.';
    fillList('catalog-warnings', (data.warnings || []).map(item => item.model + ': alias ' + item.alias + ' dropped (' + item.reason + ')'));
    const body = $('models');
    body.replaceChildren();
    for (const model of data.models) {
      const row = document.createElement('tr');
      cell(row, model.id, 'zx-mono models-id');
      cell(row, model.provider_type);
      cell(row, '').appendChild(statusBadge(model));
      cell(row, model.served_from + (model.matches_code ? ' (= code)' : ''));
      cell(row, (model.served_tiers || []).join(', ') || '—');
      const change = cell(row, '');
      if (model.pending) change.appendChild(badge('pending r' + model.pending.revision, model.pending.risky.length ? 'danger' : 'warning'));
      cell(row, '').appendChild(button('Review', '', () => review(model.id)));
      body.appendChild(row);
    }
    for (const model of data.code_only || []) {
      const row = document.createElement('tr');
      cell(row, model.id, 'zx-mono models-id');
      cell(row, model.provider_type);
      cell(row, '').appendChild(badge('code only'));
      cell(row, model.served_from);
      cell(row, (model.preview && model.preview.tiers || []).join(', '));
      cell(row, '');
      cell(row, '');
      body.appendChild(row);
    }
    $('empty').hidden = data.models.length > 0;
    return data.access_configured ? '' : 'The gateway does not verify Cloudflare Access for this page ' +
      '(CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are unset), so the admin token is the only lock.';
  }

  async function refresh() {
    const [typeAnswer, listAnswer] = await Promise.all([api(API + '/types'), api(API + '/models')]);
    if (!token) return null;
    if (!typeAnswer.ok) { say(errorText(typeAnswer.body, 'Could not load the provider types (HTTP ' + typeAnswer.status + ').'), 'error'); return null; }
    if (!listAnswer.ok) { say(errorText(listAnswer.body, 'Could not load the catalog (HTTP ' + listAnswer.status + ').'), 'error'); return null; }
    types = typeAnswer.body.types || [];
    fillTypes();
    return render(listAnswer.body);
  }

  // ── Detail and decisions ──

  async function review(id) {
    const { ok, status, body } = await api(API + '/model?id=' + encodeURIComponent(id));
    if (!token) return;
    if (!ok) { say(errorText(body, 'Could not load ' + id + ' (HTTP ' + status + ').'), 'error'); return; }
    current = body.model;
    const model = current;
    $('detail').hidden = false;
    $('detail-title').textContent = model.id;
    $('detail-meta').textContent = model.provider_type + ' · ' + model.status + ' · source ' + model.source +
      ' · serves from ' + model.served_from + (model.matches_code ? ' (equal to code)' : '') + ' · changed ' + when(model.updated_at);
    fillList('detail-reasons', (model.loader_reasons || []).map(reason => 'Not served as stored: ' + reason)
      .concat((model.dropped_pools || []).map(tier => 'Dropped pool: ' + tier)));
    fillSpec('active-spec', specPairs(model.active && model.active.spec, model.active && model.active.preview));
    const pending = model.pending;
    $('pending').hidden = !pending;
    if (pending) {
      $('pending-title').textContent = 'Pending change: revision ' + pending.revision + ' by ' + pending.author +
        (pending.note ? ' (' + pending.note + ')' : '');
      const diff = $('diff');
      diff.replaceChildren();
      for (const item of pending.diff) {
        const row = document.createElement('tr');
        if (pending.risky.includes(item.path)) row.className = 'models-risky';
        cell(row, item.path, 'zx-mono');
        cell(row, show(item.from));
        cell(row, show(item.to) + (item.billed && item.billed.to !== null ? ' (users pay ' + item.billed.to + ')' : ''));
        cell(row, item.flag);
        diff.appendChild(row);
      }
      const reasons = reasonLines(pending.validation);
      fillList('pending-validation', reasons.length ? reasons : ['Passes the code guardrails.'], reasons.length ? 'models-danger' : '');
      fillSpec('pending-preview', specPairs(pending.spec, pending.preview));
      $('approve').disabled = reasons.length > 0;
    }
    $('disable').hidden = model.status === 'disabled';
    $('enable').hidden = model.status !== 'disabled' || !model.active;
    const events = body.events || [];
    fillList('events', events.map(event => when(event.at) + ' · ' + event.actor + ' · ' + event.action +
      (event.from_status || event.to_status ? ' (' + show(event.from_status) + ' → ' + show(event.to_status) + ')' : '') +
      (event.note ? ' · ' + event.note : '')));
  }

  async function decide(path, payload, done) {
    if (busy) return;
    busy = true;
    try {
      const { ok, status, body } = await api(API + path, { method: 'POST', body: payload });
      if (!token) return;
      if (!ok) { say(errorText(body, 'The gateway refused (HTTP ' + status + ').'), 'error'); return; }
      $('decision-note').value = '';
      await refresh();
      await review(payload.model_id);
      say(done(body), 'success');
    } catch (error) {
      say(failureText(error), 'error');
    } finally {
      busy = false;
    }
  }

  function approve() {
    const model = current;
    if (!model || !model.pending) return;
    const payload = { model_id: model.id, revision_id: model.pending.revision_id,
      expected_active_revision_id: model.active ? model.active.revision_id : null, note: $('decision-note').value.trim() || null };
    if (model.pending.risky.length) {
      const typed = window.prompt('This change moves ' + model.pending.risky.join(', ') + '. Type ' + model.id + ' to approve it.');
      if (typed !== model.id) { say('Not approved: the model id was not typed.', 'warning'); return; }
      payload.confirm = typed;
    } else if (!window.confirm('Approve revision ' + model.pending.revision + ' of ' + model.id + '? It serves within a minute.')) return;
    return decide('/approve', payload, body => 'Approved. Every gateway instance serves it within ' + body.served_within_seconds + ' seconds.');
  }

  function reject() {
    const model = current;
    if (!model || !model.pending || !window.confirm('Reject revision ' + model.pending.revision + ' of ' + model.id + '?')) return;
    return decide('/reject', { model_id: model.id, revision_id: model.pending.revision_id,
      note: $('decision-note').value.trim() || null }, () => 'Rejected; the serving revision is unchanged.');
  }

  function setStatus(to) {
    const model = current;
    if (!model) return;
    const verb = to === 'disabled' ? 'Disable' : 'Enable';
    if (!window.confirm(verb + ' ' + model.id + '? ' + (to === 'disabled' ? 'It stops serving within a minute, code entry included.'
      : 'Its approved revision serves again within a minute.'))) return;
    return decide(to === 'disabled' ? '/disable' : '/enable', { model_id: model.id, note: $('decision-note').value.trim() || null },
      () => verb + 'd ' + model.id + '.');
  }

  // ── Editor ──

  const typeById = id => types.find(type => type.id === id) || null;
  const number = id => { const text = String($(id).value).trim(); return text === '' ? null : Number(text); };
  const words = id => String($(id).value).split(',').map(item => item.trim()).filter(Boolean);
  const setValue = (id, value) => { $(id).value = value === null || value === undefined ? '' : String(value); };

  function fillSelect(id, options) {
    const select = $(id);
    select.replaceChildren();
    for (const [value, label] of options) {
      const option = node('option', label);
      option.value = value;
      select.appendChild(option);
    }
    select.value = options.length ? options[0][0] : '';
  }

  function fillTypes() {
    fillSelect('f-type', types.map(type => [type.id, type.id]));
    typeChanged();
  }

  function typeChanged() {
    const type = typeById($('f-type').value);
    if (!type) return;
    fillSelect('f-free-slot', type.slots.free.map(slot => [slot.id, slot.id + (slot.configured ? '' : ' (not configured)')]));
    fillSelect('f-paid-slot', type.slots.paid.map(slot => [slot.id, slot.id + (slot.configured ? '' : ' (not configured)')]));
    $('free-pool').hidden = !type.slots.free.length;
    $('paid-pool').hidden = !type.slots.paid.length;
    $('f-paid-hint').textContent = type.slots.paid.length ? 'Cap at most $' + type.max_daily_spend_usd + ' a day. ' +
      'Only models with a list price in code can be paid, at exactly that price.' : '';
    upstreamChanged();
  }

  function upstreamChanged() {
    const type = typeById($('f-type').value);
    const upstream = String($('f-upstream').value).trim();
    $('f-id').textContent = type && upstream ? type.id_prefix + upstream : '—';
    const list = type && type.list_prices[upstream];
    if (list && !editing) {
      setValue('f-paid-input', list.input_usd_per_mtok);
      setValue('f-paid-output', list.output_usd_per_mtok);
      setValue('f-paid-cache-read', list.cache_read_usd_per_mtok);
      setValue('f-paid-cache-write', list.cache_write_usd_per_mtok);
      setValue('f-paid-cache-write-1h', list.cache_write_1h_usd_per_mtok);
    }
  }

  function openEditor(spec, id) {
    editing = id ? { id, long_context: null } : null;
    $('editor').hidden = false;
    $('editor-title').textContent = id ? 'Propose a change to ' + id : 'Add a model';
    $('check-result').replaceChildren();
    $('check-preview').replaceChildren();
    const s = spec || { provider_type: types.length ? types[0].id : '', upstream_model: '', display_name: '', context_window: 131072,
      max_output_tokens: 16384, default_max_tokens: null, supports_tools: true, supports_vision: false, reasoning_efforts: [],
      reasoning_effort_map: {}, default_reasoning_effort: null, aliases: [], geo_block_free: [], auto_rank: null, position: 1000,
      default_enabled: true, pools: [] };
    $('f-type').value = s.provider_type;
    typeChanged();
    $('f-type').disabled = Boolean(id);
    $('f-upstream').disabled = Boolean(id);
    setValue('f-upstream', s.upstream_model);
    setValue('f-name', s.display_name);
    setValue('f-aliases', (s.aliases || []).join(', '));
    setValue('f-context', s.context_window);
    setValue('f-max', s.max_output_tokens);
    setValue('f-default-max', s.default_max_tokens);
    setValue('f-efforts', (s.reasoning_efforts || []).join(', '));
    setValue('f-effort-map', Object.entries(s.reasoning_effort_map || {}).map(([key, value]) => key + '=' + value).join(', '));
    setValue('f-default-effort', s.default_reasoning_effort);
    setValue('f-auto', s.auto_rank);
    setValue('f-position', s.position);
    setValue('f-geo', (s.geo_block_free || []).join(', '));
    $('f-tools').checked = s.supports_tools !== false;
    $('f-vision').checked = s.supports_vision === true;
    $('f-enabled').checked = s.default_enabled !== false;
    const free = (s.pools || []).find(pool => pool.tier === 'free');
    const paid = (s.pools || []).find(pool => pool.tier === 'paid');
    $('f-free-on').checked = Boolean(free);
    if (free) {
      $('f-free-slot').value = free.key_slot;
      for (const key of ['rpm', 'rpd', 'tpm', 'tpd']) setValue('f-free-' + key, free.limits[key]);
    } else for (const key of ['rpm', 'rpd', 'tpm', 'tpd']) setValue('f-free-' + key, null);
    $('f-paid-on').checked = Boolean(paid);
    if (paid) {
      $('f-paid-slot').value = paid.key_slot;
      setValue('f-paid-cap', paid.daily_spend_cap_usd);
      setValue('f-paid-input', paid.price && paid.price.input_usd_per_mtok);
      setValue('f-paid-output', paid.price && paid.price.output_usd_per_mtok);
      setValue('f-paid-cache-read', paid.price && paid.price.cache_read_usd_per_mtok);
      setValue('f-paid-cache-write', paid.price && paid.price.cache_write_usd_per_mtok);
      setValue('f-paid-cache-write-1h', paid.price && paid.price.cache_write_1h_usd_per_mtok);
      if (editing) editing.long_context = paid.price ? paid.price.long_context : null;
    } else setValue('f-paid-cap', null);
    $('f-name').focus();
  }

  function effortMap() {
    const map = {};
    for (const pair of words('f-effort-map')) {
      const [key, value] = pair.split('=').map(item => item.trim());
      if (key && value) map[key] = value;
    }
    return map;
  }

  function specFromForm() {
    const pools = [];
    if ($('f-free-on').checked && !$('free-pool').hidden) {
      pools.push({ tier: 'free', key_slot: $('f-free-slot').value, price: null,
        limits: { rpm: number('f-free-rpm'), rpd: number('f-free-rpd'), tpm: number('f-free-tpm'), tpd: number('f-free-tpd') },
        daily_spend_cap_usd: null });
    }
    if ($('f-paid-on').checked && !$('paid-pool').hidden) {
      pools.push({ tier: 'paid', key_slot: $('f-paid-slot').value,
        price: { input_usd_per_mtok: number('f-paid-input'), output_usd_per_mtok: number('f-paid-output'),
          cache_read_usd_per_mtok: number('f-paid-cache-read'), cache_write_usd_per_mtok: number('f-paid-cache-write'),
          cache_write_1h_usd_per_mtok: number('f-paid-cache-write-1h'), long_context: editing ? editing.long_context : null },
        limits: { rpm: null, rpd: null, tpm: null, tpd: null }, daily_spend_cap_usd: number('f-paid-cap') });
    }
    return {
      provider_type: $('f-type').value, upstream_model: String($('f-upstream').value).trim(), display_name: String($('f-name').value).trim(),
      context_window: number('f-context'), max_output_tokens: number('f-max'), default_max_tokens: number('f-default-max'),
      supports_tools: $('f-tools').checked, supports_vision: $('f-vision').checked,
      reasoning_efforts: words('f-efforts'), reasoning_effort_map: effortMap(),
      default_reasoning_effort: String($('f-default-effort').value).trim() || null, aliases: words('f-aliases'),
      geo_block_free: words('f-geo'), auto_rank: number('f-auto'), position: number('f-position'),
      default_enabled: $('f-enabled').checked, pools,
    };
  }

  function showCheck(body) {
    const lines = (body.errors || []).concat(reasonLines(body.validation));
    const diff = (body.diff || []).map(item => (body.risky && body.risky.includes(item.path) ? 'Needs confirmation: ' : 'Change: ') +
      item.path + ' ' + show(item.from) + ' → ' + show(item.to));
    fillList('check-result', lines.length ? lines : ['Passes the code guardrails.'].concat(diff), lines.length ? 'models-danger' : '');
    if (body.preview) fillSpec('check-preview', [['Public id', body.preview.id], ['Tiers', body.preview.tiers.join(', ')],
      ['Users pay', show(body.preview.pricing)], ['Chosen by auto', body.preview.chosen_by_auto ? 'yes' : 'no']]);
  }

  async function check() {
    if (busy) return;
    busy = true;
    try {
      const { ok, status, body } = await api(API + '/validate', { method: 'POST', body: { spec: specFromForm() } });
      if (!token) return;
      if (!ok) { say(errorText(body, 'Could not check the model (HTTP ' + status + ').'), 'error'); return; }
      showCheck(body);
      say(body.ok ? 'The model passes the guardrails. Save it as a draft to review it.' : 'The model does not pass the guardrails yet.',
        body.ok ? 'info' : 'warning');
    } catch (error) {
      say(failureText(error), 'error');
    } finally {
      busy = false;
    }
  }

  async function save(event) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    try {
      const { ok, status, body } = await api(API + '/propose', { method: 'POST',
        body: { spec: specFromForm(), note: String($('f-note').value).trim() || null } });
      if (!token) return;
      if (!ok) {
        if (body && body.error) showCheck({ errors: body.error.reasons || [], validation: body.error.validation || null });
        say(errorText(body, 'The draft was not saved (HTTP ' + status + ').'), 'error');
        return;
      }
      $('editor').hidden = true;
      setValue('f-note', null);
      editing = null;
      await refresh();
      await review(body.model_id);
      say('Saved revision ' + body.revision + ' of ' + body.model_id + ' as a draft. Review and approve it to serve it.', 'success');
    } catch (error) {
      say(failureText(error), 'error');
    } finally {
      busy = false;
    }
  }

  // ── Audit ──

  async function loadAudit() {
    const { ok, status, body } = await api(API + '/audit?limit=100');
    if (!token) return;
    if (!ok) { say(errorText(body, 'Could not load the audit log (HTTP ' + status + ').'), 'error'); return; }
    fillList('audit', (body.events || []).map(event => when(event.at) + ' · ' + (event.subject_kind || 'model') + ' ' +
      (event.subject_id || event.model_id) + ' · ' + event.actor + ' · ' + event.action + (event.note ? ' · ' + event.note : '')));
  }

  // ── Lock ──

  function lock(text) {
    token = '';
    current = null;
    editing = null;
    $('models').replaceChildren();
    $('catalog').hidden = true;
    $('detail').hidden = true;
    $('editor').hidden = true;
    $('unlock').hidden = false;
    say(text || '');
    $('admin-token').focus();
  }

  async function unlock(event) {
    event.preventDefault();
    if (busy) return;
    const input = $('admin-token');
    token = String(input.value).trim();
    input.value = '';
    if (!token) return;
    busy = true;
    $('unlock-button').disabled = true;
    say('Loading…');
    try {
      const warning = await refresh();
      if (warning === null) return;
      $('unlock').hidden = true;
      $('catalog').hidden = false;
      say(warning, warning ? 'warning' : 'info');
      let wanted = null;
      try { wanted = new URLSearchParams(window.location.search).get('id'); } catch { /* no location */ }
      if (wanted) await review(wanted);
    } catch (error) {
      token = '';
      say(failureText(error), 'error');
    } finally {
      busy = false;
      $('unlock-button').disabled = false;
    }
  }

  $('unlock').addEventListener('submit', unlock);
  $('lock').addEventListener('click', () => lock('Token forgotten.'));
  $('new-model').addEventListener('click', () => openEditor(null, null));
  $('edit').addEventListener('click', () => current && openEditor((current.pending || current.active || {}).spec || null, current.id));
  $('close-detail').addEventListener('click', () => { $('detail').hidden = true; current = null; });
  $('approve').addEventListener('click', approve);
  $('reject').addEventListener('click', reject);
  $('disable').addEventListener('click', () => setStatus('disabled'));
  $('enable').addEventListener('click', () => setStatus('active'));
  $('f-type').addEventListener('change', typeChanged);
  $('f-upstream').addEventListener('input', upstreamChanged);
  $('check').addEventListener('click', check);
  $('editor').addEventListener('submit', save);
  $('cancel-edit').addEventListener('click', () => { $('editor').hidden = true; editing = null; });
  $('load-audit').addEventListener('click', loadAudit);
})();

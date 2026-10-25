// GET /admin/discovery: the operator's review page. A static shell with no data; it asks for
// GATEWAY_ADMIN_TOKEN (kept in sessionStorage for this tab) and calls /admin/discovery/*.
// Candidate fields come from the internet, so everything is rendered with textContent, links
// only for https URLs, opened with noopener and noreferrer.
export const REVIEW_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Provider discovery</title>
<style>
:root { --bg: #f7f7f5; --panel: #fff; --text: #1d1d1b; --muted: #6b6b66; --line: #e2e1dc; --accent: #2457d6;
  --good: #1f7a3d; --warn: #9a5b00; --bad: #b42318; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #151514; --panel: #1e1e1c; --text: #ecebe6; --muted: #9b9a93;
  --line: #34332f; --accent: #7aa2ff; --good: #5cc37f; --warn: #e0a548; --bad: #ff7a6b; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1280px; margin: 0 auto; padding: 20px 16px 48px; }
h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 24px 0 8px; }
p.lead { margin: 0 0 16px; color: var(--muted); }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
input, select, button { font: inherit; color: inherit; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; }
input[type=password], input[type=search] { min-width: 220px; }
button { cursor: pointer; } button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button:disabled { opacity: .5; cursor: default; }
.chip { border-radius: 999px; padding: 3px 10px; font-size: 13px; }
.chip.active { border-color: var(--accent); color: var(--accent); font-weight: 600; }
.status { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .02em; }
.status.new { color: var(--accent); } .status.verified { color: var(--good); } .status.approved { color: var(--warn); }
.status.excluded, .status.rejected { color: var(--bad); } .status.filtered { color: var(--muted); }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; background: var(--panel); }
th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 12px; color: var(--muted); font-weight: 600; white-space: nowrap; }
td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.muted { color: var(--muted); } .small { font-size: 12px; } .bad { color: var(--bad); } .good { color: var(--good); }
.model { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; word-break: break-all; }
.actions { display: flex; gap: 4px; flex-wrap: wrap; } .actions button { padding: 3px 8px; font-size: 12px; }
pre { white-space: pre-wrap; word-break: break-word; font-size: 12px; background: var(--bg); padding: 8px; border-radius: 6px; margin: 6px 0 0; max-height: 360px; overflow: auto; }
#message { min-height: 20px; margin: 8px 0; }
</style>
</head>
<body>
<main>
  <h1>Provider discovery</h1>
  <p class="lead">Candidates found by the daily lists, the weekly OmniRoute diff and the research agent. Nothing here is served until you approve it, a live tool call verifies it, you promote it to a draft catalog row and approve that row on the model catalog page (/admin/models). Signing up to a provider stays manual.</p>
  <div class="panel row">
    <label for="token">Admin token</label>
    <input id="token" type="password" autocomplete="off" placeholder="GATEWAY_ADMIN_TOKEN">
    <button id="use-token" class="primary">Load</button>
    <span id="settings" class="muted small"></span>
  </div>
  <div class="panel">
    <div class="row" id="counts"></div>
    <div class="row" style="margin-top:8px">
      <input id="provider" type="search" placeholder="Provider id">
      <input id="search" type="search" placeholder="Search model or provider">
      <button id="apply">Filter</button>
      <button id="reject-selected" disabled>Reject selected</button>
    </div>
  </div>
  <div id="message" role="status" aria-live="polite"></div>
  <div class="table-wrap"><table>
    <thead><tr><th><input type="checkbox" id="select-all" aria-label="Select all"></th><th>Provider / model</th><th>Context</th>
      <th>Tools</th><th>Vision</th><th>Status</th><th>Seen</th><th>Source</th><th>Actions</th></tr></thead>
    <tbody id="rows"></tbody>
  </table></div>
  <div class="row" style="margin-top:8px"><button id="prev">Previous</button><span id="page" class="muted small"></span><button id="next">Next</button></div>
  <h2>Jobs</h2>
  <div class="row" style="margin-bottom:8px">
    <button id="run-lists">Run the daily lists now</button>
    <button id="run-omniroute">Run the OmniRoute diff now</button>
    <button id="run-research">Run research now</button>
  </div>
  <div class="table-wrap"><table>
    <thead><tr><th>Job</th><th>Last success</th><th>Next run</th><th>Runs</th><th>Spent</th><th>Last result</th></tr></thead>
    <tbody id="jobs"></tbody>
  </table></div>
</main>
<script>
(() => {
  const base = location.pathname.replace(/\\/admin\\/discovery\\/?$/, '');
  const state = { status: 'new', offset: 0, limit: 100, total: 0, selected: new Set(), settings: null };
  const $ = id => document.getElementById(id);
  const STATUSES = ['new', 'approved', 'verified', 'rejected', 'filtered', 'excluded', 'all'];
  try { $('token').value = sessionStorage.getItem('zx-admin-token') || ''; } catch {}

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value; else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value); else node.setAttribute(key, value);
    }
    for (const child of children) if (child !== null && child !== undefined) node.append(child);
    return node;
  }
  const say = (text, kind = '') => { $('message').className = kind; $('message').textContent = text; };
  const day = value => value ? new Date(value).toISOString().slice(0, 10) : '';
  const when = value => value ? new Date(value).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '';
  const yes = value => value === true ? 'yes' : value === false ? 'no' : '?';
  const tokens = value => value ? (value >= 1000 ? Math.round(value / 1024) + 'K' : String(value)) : '?';
  function link(url, text) {
    if (typeof url !== 'string' || !url.startsWith('https://')) return document.createTextNode(text);
    return el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text });
  }

  async function api(path, options = {}) {
    const token = $('token').value.trim();
    const response = await fetch(base + path, { ...options, headers: { Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json', ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message || ('HTTP ' + response.status));
    return body;
  }

  function renderCounts(counts) {
    const box = $('counts'); box.replaceChildren();
    for (const status of STATUSES) {
      const count = status === 'all' ? Object.values(counts).reduce((a, b) => a + b, 0) : (counts[status] || 0);
      box.append(el('button', { class: 'chip' + (state.status === status ? ' active' : ''), text: status + ' ' + count,
        onclick: () => { state.status = status; state.offset = 0; load(); } }));
    }
  }

  function renderJobs(jobs) {
    const body = $('jobs'); body.replaceChildren();
    for (const job of jobs) {
      const result = job.last_error ? el('span', { class: 'bad', text: job.last_error })
        : el('span', { class: 'small muted', text: JSON.stringify(job.last_summary || {}) });
      body.append(el('tr', {}, el('td', { class: 'model', text: job.job }), el('td', { text: when(job.last_ok_at) }),
        el('td', { text: when(job.next_run_at) }), el('td', { class: 'num', text: String(job.runs) }),
        el('td', { class: 'num', text: job.spent_microusd ? '$' + (job.spent_microusd / 1e6).toFixed(3) : '' }), el('td', {}, result)));
    }
  }

  function details(row) {
    const info = { notes: row.notes, review_notes: row.review_notes, excluded_reason: row.excluded_reason,
      verification: row.verification, promoted_model_id: row.promoted_model_id, promoted: row.promoted,
      first_seen: row.first_seen, gone_at: row.gone_at };
    return el('pre', { text: JSON.stringify(info, null, 2) });
  }

  async function act(row, action, button) {
    button.disabled = true;
    try {
      if (action === 'reject') {
        const reason = prompt('Reason (optional)') ?? null;
        await api('/admin/discovery/candidates/' + row.id + '/reject', { method: 'POST', body: JSON.stringify({ note: reason }) });
        say('Rejected ' + (row.model_id || row.provider) + '.', 'good');
      } else if (action === 'approve' || action === 'verify') {
        say((action === 'approve' ? 'Approving' : 'Verifying') + ' ' + (row.model_id || row.provider) + '…');
        const result = await api('/admin/discovery/candidates/' + row.id + '/' + action, { method: 'POST', body: '{}' });
        const check = result.verification;
        say(check ? (check.passed ? 'Verified: the streamed tool call passed.' : 'Not verified: ' + (check.error?.message || 'no tool call'))
          : result.message || 'Approved.', check && !check.passed ? 'bad' : 'good');
      } else if (action === 'promote') {
        const result = await api('/admin/discovery/candidates/' + row.id + '/promote', { method: 'POST', body: '{}' });
        say('Saved ' + result.promoted?.public_model_id + ' as a draft. ' + (result.notes || []).join(' '), 'good');
      } else if (action === 'demote') {
        await api('/admin/discovery/candidates/' + row.id + '/demote', { method: 'POST', body: '{}' });
        say('Removed from the catalog.', 'good');
      }
      await load(false);
    } catch (error) { say(error.message, 'bad'); button.disabled = false; }
  }

  function renderRows(rows) {
    const body = $('rows'); body.replaceChildren(); state.selected.clear(); $('reject-selected').disabled = true;
    if (!rows.length) { body.append(el('tr', {}, el('td', { colspan: '9', class: 'muted', text: 'Nothing here.' }))); return; }
    for (const row of rows) {
      const status = row.filtered ? 'filtered' : row.status;
      const select = el('input', { type: 'checkbox', 'aria-label': 'Select', onchange: event => {
        if (event.target.checked) state.selected.add(row.id); else state.selected.delete(row.id);
        $('reject-selected').disabled = !state.selected.size; } });
      const actions = el('div', { class: 'actions' });
      const button = (label, action) => { const b = el('button', { text: label }); b.addEventListener('click', () => act(row, action, b)); actions.append(b); };
      if (row.status !== 'excluded' && row.status !== 'verified' && row.status !== 'approved') button('Approve', 'approve');
      if (['approved', 'verified'].includes(row.status) && row.verifiable) button('Verify', 'verify');
      if (row.status === 'verified' && row.catalog_template && !row.promoted && !row.catalog_model_id) button('Promote', 'promote');
      if (row.catalog_model_id) {
        actions.append(link('https://dashboard.zero-x.live/admin/models?id=' + encodeURIComponent(row.catalog_model_id),
          'Catalog: ' + row.catalog_status));
      }
      if (row.promoted) button('Remove from catalog', 'demote');
      if (row.status !== 'excluded' && !(row.status === 'rejected' && !row.filtered)) button('Reject', 'reject');
      const more = el('button', { text: 'Details' });
      const name = el('td', {}, el('div', {}, el('strong', { text: row.provider })),
        el('div', { class: 'model', text: row.model_id || '(provider record)' }),
        row.display_name ? el('div', { class: 'small muted', text: row.display_name }) : null);
      more.addEventListener('click', () => { if (name.querySelector('pre')) name.querySelector('pre').remove(); else name.append(details(row)); });
      actions.append(more);
      const seen = el('td', { class: 'small' }, el('div', { text: 'last ' + day(row.last_seen) }),
        row.gone_at ? el('div', { class: 'bad', text: 'gone ' + day(row.gone_at) }) : null);
      body.append(el('tr', {}, el('td', {}, select), name, el('td', { class: 'num', text: tokens(row.context_window) }),
        el('td', { text: yes(row.supports_tools) }), el('td', { text: yes(row.supports_vision) }),
        el('td', {}, el('span', { class: 'status ' + status, text: status }),
          row.verifiable ? null : el('div', { class: 'small muted', text: row.model_id ? 'no key' : '' })),
        seen, el('td', { class: 'small' }, el('div', { text: row.source }), link(row.evidence_url, 'evidence')), el('td', {}, actions)));
    }
  }

  async function load(clear = true) {
    try { sessionStorage.setItem('zx-admin-token', $('token').value.trim()); } catch {}
    if (clear) say('Loading…');
    const query = new URLSearchParams({ status: state.status, limit: String(state.limit), offset: String(state.offset) });
    if ($('provider').value.trim()) query.set('provider', $('provider').value.trim());
    if ($('search').value.trim()) query.set('q', $('search').value.trim());
    try {
      const result = await api('/admin/discovery/candidates?' + query);
      state.total = result.total; state.settings = result.settings;
      renderCounts(result.overview.counts || {}); renderRows(result.data); renderJobs(result.overview.jobs || []);
      $('page').textContent = result.total ? (state.offset + 1) + '–' + (state.offset + result.data.length) + ' of ' + result.total : '';
      $('prev').disabled = state.offset === 0; $('next').disabled = state.offset + state.limit >= state.total;
      const s = result.settings;
      $('settings').textContent = 'Discovery ' + (s.discovery_enabled ? 'on' : 'off') + ' · catalog '
        + (s.catalog_source === 'code' ? 'code only (CATALOG_SOURCE=code)' : 'rows approved on /admin/models') + ' · research '
        + (s.research_enabled ? 'on, up to $' + s.research_cap_usd + ' a run' : 'off (no ANTHROPIC_API_KEY, or DISCOVERY_RESEARCH=false)');
      $('run-research').disabled = !s.research_enabled;
      if (clear) say('');
    } catch (error) { say(error.message, 'bad'); }
  }

  async function run(jobs, label) {
    if (jobs.includes('research') && !confirm('Research calls Claude with web search and spends up to $' + state.settings?.research_cap_usd + '. Run it now?')) return;
    say('Running ' + label + '…');
    try {
      const result = await api('/admin/discovery/run', { method: 'POST', body: JSON.stringify(jobs.length ? { jobs } : {}) });
      const failed = (result.ran || []).filter(item => !item.ok);
      say(result.skipped ? 'Skipped: ' + result.skipped : (result.ran || []).length + ' job(s) ran' + (failed.length ? ', failed: ' + failed.map(item => item.job + ' (' + item.error + ')').join('; ') : '.'), failed.length || result.skipped ? 'bad' : 'good');
      await load(false);
    } catch (error) { say(error.message, 'bad'); }
  }

  $('use-token').addEventListener('click', () => load());
  $('apply').addEventListener('click', () => { state.offset = 0; load(); });
  $('prev').addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); load(); });
  $('next').addEventListener('click', () => { state.offset += state.limit; load(); });
  $('select-all').addEventListener('change', event => {
    for (const box of $('rows').querySelectorAll('input[type=checkbox]')) { box.checked = event.target.checked; box.dispatchEvent(new Event('change')); }
  });
  $('reject-selected').addEventListener('click', async () => {
    const ids = [...state.selected]; if (!ids.length || !confirm('Reject ' + ids.length + ' candidate(s)?')) return;
    try { const result = await api('/admin/discovery/candidates/reject', { method: 'POST', body: JSON.stringify({ ids }) });
      say('Rejected ' + result.rejected.length + '.', 'good'); await load(false); } catch (error) { say(error.message, 'bad'); }
  });
  $('run-lists').addEventListener('click', () => run([], 'the daily lists'));
  $('run-omniroute').addEventListener('click', () => run(['omniroute'], 'the OmniRoute diff'));
  $('run-research').addEventListener('click', () => run(['research'], 'research'));
  if ($('token').value) load();
})();
</script>
</body>
</html>
`;

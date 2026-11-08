// Provider callback page (neuroncli/callback/index.html) in a fake DOM: rejected callbacks never
// claim success or show provider keys, validated gateway tokens copy safely, the URL is cleared,
// and the outcome is the shared full-page result screen (focused, no live region, textContent only).
//   node check-callback.mjs
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../callback/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const OK = 'Connection complete';
const FAIL = 'Connection failed';
// A bare visit points to Neuron sign-in; a failed provider connection says to start it again.
const SIGN_IN = 'To sign in to Neuron, run neuron login in your terminal and approve the code at neuron.zero-x.live/device.';
const RETRY = 'Start the connection again from Zero-X.';
for (const [search, status, expected, payload = {}, copies = false, retry = RETRY] of [
  ['', 200, FAIL, {}, false, SIGN_IN],
  ['?code=%3Cimg%20src=x%20onerror=alert(1)%3E&state=test', 400, FAIL],
  ['?provider=azure&session_token=invalid', 401, FAIL],
  ['?provider=azure&session_token=test', 200, OK],
  ['?code=valid&state=test', 200, OK, {session_token:'ses_gateway'}, true],
  ['?code=valid&state=test', 200, FAIL, {session_token:'sk_provider_secret'}],
  ['?code=valid&state=test', 200, FAIL, {}],
]) {
  const elements = new Map();
  const focused = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, {id, style:{}, textContent:'', className:'', hidden:id === 'session' || id === 'copy-session',
      addEventListener(event,fn){this[event]=fn;}, focus(){focused.push(id);},
      set innerHTML(_) {throw new Error('Untrusted callback content reached HTML');}});
    return elements.get(id);
  };
  let cleared = false;
  const document = {getElementById:element, title:'Connecting your account | Zero-X'};
  const context = vm.createContext({URLSearchParams, AbortSignal,
    location:{hostname:'www.zero-x.live', pathname:'/neuroncli/callback/', search},
    history:{replaceState(){cleared = true;}}, document,
    navigator:{clipboard:{async writeText(value){assert.equal(value,'ses_gateway');}}},
    fetch:async (path) => {assert.ok(path.startsWith('/neuroncli/auth-server/auth/'));return new Response(JSON.stringify(payload), {status});},
  });
  vm.runInContext(script,context);
  await vm.runInContext('complete()',context);
  assert.equal(element('title').textContent, expected, search);
  assert.equal(document.title, expected + ' | Zero-X');
  assert.ok(cleared, 'Callback credentials must be removed from browser history');
  for (const id of ['message', 'detail']) assert.ok(!element(id).textContent.includes('<img'));
  assert.equal(element('spinner').hidden, true, 'the working badge goes once finished');
  assert.equal(focused.at(-1), 'title', 'focus moves to the headline so it is read out');
  if (expected === FAIL) {
    assert.equal(element('result').className, 'ap-result is-failed');
    assert.equal(element('detail').textContent, retry, 'a failure says how to retry, per case');
    assert.ok(retry === SIGN_IN || !element('detail').textContent.includes('neuron login'), 'a provider failure never says neuron login');
    assert.ok(element('message').textContent.length > 10, 'a failure keeps the error text');
    assert.ok(!element('message').textContent.includes('sk_provider_secret'));
  } else {
    assert.equal(element('result').className, 'ap-result');
    assert.match(element('message').textContent, copies ? /Copy the gateway token below/ : /You can close this tab and return to your terminal\./);
  }
  if(copies){assert.equal(element('session').textContent,'ses_gateway');assert.equal(element('copy-session').hidden,false);await element('copy-session').click();assert.equal(element('copy-session').textContent,'Copied');}
  else {assert.equal(element('session').hidden, true, 'no token shown');}
}

// Markup: the shared result screen with the Zero-X mark and a focusable headline. The section is
// not a live region: it holds the gateway token, which must never be read out as a live update;
// the focus move to the headline announces the outcome.
assert.match(html, /<section class="ap-result" id="result">/);
assert.doesNotMatch(html, /aria-live|role="status"/, 'no live region on the callback page');
assert.match(html, /<h1 id="title" class="ap-result-title" tabindex="-1">Connecting your account<\/h1>/, 'working headline matches the tab title');
assert.match(html, /<p id="message" class="ap-result-line">This takes a few seconds\.<\/p>/);
assert.match(html, /<img class="ap-result-mark" src="\/Assets\/zerox-mark\.svg"/);
assert.match(html, /<h1 id="title" class="ap-result-title" tabindex="-1">/);
assert.match(html, /<p id="message" class="ap-result-line">/);
assert.match(html, /<p id="detail" class="ap-result-detail">/);
assert.doesNotMatch(script, /innerHTML|\.style\./, 'textContent only, no inline styles from script');
console.log('PASS: rejected callbacks cannot claim success or expose provider keys; validated gateway tokens copy safely and callback URLs are cleared; outcome shown on the full-page result screen, focused headline, no live region');

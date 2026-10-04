import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../callback/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
for (const [search, status, expected, payload = {}, copies = false] of [
  ['', 200, 'Authentication Failed'],
  ['?code=%3Cimg%20src=x%20onerror=alert(1)%3E&state=test', 400, 'Authentication Failed'],
  ['?provider=azure&session_token=invalid', 401, 'Authentication Failed'],
  ['?provider=azure&session_token=test', 200, 'Authentication Complete'],
  ['?code=valid&state=test', 200, 'Authentication Complete', {session_token:'ses_gateway'}, true],
  ['?code=valid&state=test', 200, 'Authentication Failed', {session_token:'sk_provider_secret'}],
  ['?code=valid&state=test', 200, 'Authentication Failed', {}],
]) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {style:{}, textContent:'', className:'',hidden:true,addEventListener(event,fn){this[event]=fn;},
      set innerHTML(_) {throw new Error('Untrusted callback content reached HTML');}});
    return elements.get(id);
  };
  let cleared = false;
  const context = vm.createContext({URLSearchParams, AbortSignal,
    location:{hostname:'www.zero-x.live', pathname:'/neuroncli/callback/', search},
    history:{replaceState(){cleared = true;}}, document:{getElementById:element},
    navigator:{clipboard:{async writeText(value){assert.equal(value,'ses_gateway');}}},
    fetch:async (path) => {assert.ok(path.startsWith('/neuroncli/auth-server/auth/'));return new Response(JSON.stringify(payload), {status});},
  });
  vm.runInContext(script,context);
  await vm.runInContext('complete()',context);
  assert.equal(element('title').textContent, expected);
  assert.ok(cleared, 'Callback credentials must be removed from browser history');
  assert.ok(!element('message').textContent.includes('<img'));
  if(copies){assert.equal(element('session').textContent,'ses_gateway');assert.equal(element('copy-session').hidden,false);await element('copy-session').click();assert.equal(element('copy-session').textContent,'Copied');}
}
console.log('PASS: rejected callbacks cannot claim success or expose provider keys; validated gateway tokens copy safely and callback URLs are cleared');

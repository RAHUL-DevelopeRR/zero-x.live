import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../callback/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
for (const [search, status, expected] of [
  ['', 200, 'Authentication Failed'],
  ['?code=%3Cimg%20src=x%20onerror=alert(1)%3E&state=test', 400, 'Authentication Failed'],
  ['?provider=azure&session_token=invalid', 401, 'Authentication Failed'],
  ['?provider=azure&session_token=test', 200, 'Authentication Complete'],
]) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {style:{}, textContent:'', className:'',
      set innerHTML(_) {throw new Error('Untrusted callback content reached HTML');}});
    return elements.get(id);
  };
  let cleared = false;
  const context = vm.createContext({URLSearchParams, AbortSignal,
    location:{hostname:'www.zero-x.live', pathname:'/neuroncli/callback/', search},
    history:{replaceState(){cleared = true;}}, document:{getElementById:element},
    fetch:async () => new Response('{}', {status}),
  });
  vm.runInContext(script,context);
  await vm.runInContext('complete()',context);
  assert.equal(element('title').textContent, expected);
  assert.ok(cleared, 'Callback credentials must be removed from browser history');
  assert.ok(!element('message').textContent.includes('<img'));
}
console.log('PASS: rejected callbacks cannot claim success, callback values stay out of HTML and browser history');

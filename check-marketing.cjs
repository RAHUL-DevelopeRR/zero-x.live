const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({
  document: {documentElement: {classList: {add() {}}}, querySelector() {return null;}, querySelectorAll() {return [];}}
});
vm.runInContext(fs.readFileSync(__dirname + '/marketing.js', 'utf8'), context);
const values = new Map([
  ['platform', 'Windows x64'], ['stage', 'Found the document I needed'],
  ['message', '  Failed & then worked? #index\nPath: C:\\Demo\\notes.txt\n&bcc=other@example.com  '],
  ['email', ' writer+demo@example.com ']
]);
const link = context.feedbackMailto(values);
assert.ok(link.startsWith('mailto:rahul@zero-x.live?'));
const parameters = new URLSearchParams(link.split('?')[1]);
assert.deepEqual([...parameters.keys()], ['subject', 'body']);
assert.equal(parameters.get('subject'), 'NeuCockpit first-use feedback');
assert.ok(parameters.get('body').includes(values.get('message').trim()));
assert.ok(parameters.get('body').endsWith('Reply email: writer+demo@example.com'));
for (const page of ['index.html', 'neuron.html', 'start.html']) {
  const source = fs.readFileSync(__dirname + '/' + page, 'utf8');
  assert.ok(!source.includes('—'), page + ': no em dash');
  assert.ok(!source.includes('counterapi') && !source.includes('simulatedVisitors'), page + ': no fictional counters');
  assert.ok(source.includes('marketing.css') && source.includes('marketing.js'));
  assert.equal((source.match(/<h1>/g) || []).length, 1, page + ': one main heading');
}
console.log('Marketing checks passed: feedback preserves content, recipient cannot be changed, source pages contain no fictional counters.');

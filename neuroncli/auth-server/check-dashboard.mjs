import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../../dashboard.html',import.meta.url),'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
const elements = new Map();
const element = id => {
  if(!elements.has(id))elements.set(id,{textContent:'',innerHTML:'',style:{},classList:{toggle(){},remove(){},contains:()=>false},setAttribute(){},addEventListener(){},focus(){}});
  return elements.get(id);
};
let boot;
const profile={id:'test-user',email:'owner@example.com',fullName:'Test Owner'};
const context = vm.createContext({
  document:{getElementById:element,querySelectorAll:()=>[],addEventListener(){}},matchMedia:()=>({matches:false,addEventListener(){}}),AbortSignal,
  window:{location:{hostname:'www.zero-x.live',origin:'https://www.zero-x.live',href:'https://www.zero-x.live/dashboard.html'},addEventListener(name,fn){if(name==='load')boot=fn;},ZeroXAuth:{async init(){},async getUser(){return {};},async getProfile(){return profile;},async getAccessToken(){return 'test';},mountUserButton(){}}},
  fetch:async()=>{throw new Error('Gateway unavailable');},
  console:{warn(){},error(){}},navigator:{clipboard:{async writeText(){}}},setTimeout,innerWidth:1200,
});
vm.runInContext(script,context);
vm.runInContext('populateDashboard(null)',context);
assert.equal(element('stat-tokens').textContent,'Unavailable');
assert.match(element('activity-tbody').innerHTML,/No account requests/);
vm.runInContext(`applyAccountState({plan:'free',usage:{tokens_used:123,requests:2},limits:{tokens:256000,requests:2000},models:['example-model']});populateDashboard(null)`,context);
assert.equal(element('stat-tokens').textContent,'123');
assert.equal(element('plan-desc').textContent,'256,000 tokens/day • 1 included models');
assert.match(element('chart-labels').innerHTML,/Today/);
assert.doesNotMatch(element('chart-labels').innerHTML,/Mon|Tue/);
await boot();
assert.equal(element('session-token-display').textContent,'Session unavailable');
assert.equal(element('copy-token-btn').disabled,true);
assert.equal(element('greeting-name').textContent,'Test Owner');
console.log('PASS: actual quotas, unavailable data, no fabricated history, and failed gateway sessions never produce dummy tokens');

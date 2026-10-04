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
assert.equal(element('plan-desc').textContent,'256,000 tokens/day • 1 included model');
vm.runInContext(`applyAccountState({plan:'enterprise',usage:{tokens_used:0,requests:0},limits:{tokens:0,requests:0},models:[]});populateDashboard(null)`,context);
assert.equal(element('stat-tokens').textContent,'0');
assert.equal(element('tokens-bar').style.width,'0%');
assert.equal(element('stat-plan').textContent,'Enterprise');
assert.match(element('models-chips').textContent,/No providers/);
vm.runInContext(`applyAccountState({plan:'free',usage:{tokens_used:10,requests:1},limits:{tokens:100,requests:10},models:['<img src=x onerror=alert(1)>']});populateDashboard(null)`,context);
assert.match(element('models-tbody').innerHTML,/&lt;img/);
assert.doesNotMatch(element('models-tbody').innerHTML,/<img/);
assert.match(element('chart-labels').innerHTML,/Today/);
assert.doesNotMatch(element('chart-labels').innerHTML,/Mon|Tue/);
await boot();
assert.equal(element('session-token-display').textContent,'Session unavailable');
assert.equal(element('copy-token-btn').disabled,true);
assert.equal(element('greeting-name').textContent,'Test Owner');
assert.match(element('account-status').textContent,/retry/);
assert.equal(element('refresh-account').disabled,false);
vm.runInContext('sessionToken="";dashboardState.accountAvailable=false',context);
let calls=[];
context.fetch=async(path,options)=>{
  calls.push(path);
  if(path==='/auth/cli/session')return new Response(JSON.stringify({session_token:'ses_test',plan:'free',usage:{tokens_used:123,requests:2},limits:{tokens:1000,requests:10},models:['example-model']}));
  if(path==='/auth/session')return new Response(JSON.stringify({plan:'free',usage:{tokens_used:0,requests:0},limits:{tokens:1000,requests:10},models:['example-model']}));
  return new Response(JSON.stringify({data:[{id:'example-model',owned_by:'groq',capabilities:{tools:true}}]}));
};
await vm.runInContext('refreshAccount()',context);
assert.equal(element('copy-token-btn').disabled,false);
assert.equal(element('stat-tokens').textContent,'123');
assert.match(element('models-tbody').innerHTML,/groq · Tools/);
await vm.runInContext('refreshAccount()',context);
assert.equal(element('stat-tokens').textContent,'0','A new quota day must replace previous usage with zero');
assert.equal(calls.filter(path=>path==='/auth/cli/session').length,1,'Refreshing must reuse the gateway session');
assert.equal(calls.filter(path=>path==='/auth/session').length,1);
console.log('PASS: dynamic provider catalog, real shared quotas, empty/error/retry states, escaped model names, and session reuse');

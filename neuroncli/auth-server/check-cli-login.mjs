import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../login/login.js',import.meta.url),'utf8');
const state='test_state_0123456789_abcdefghijklmno';
const drain=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));};
async function run(callback,sessionToken='ses_gateway',signedIn=true,extra={}){
  const elements=new Map();
  const el=id=>{if(!elements.has(id))elements.set(id,{textContent:'',hidden:true,disabled:false,addEventListener(event,fn){this[event]=fn;}});return elements.get(id);};
  const storage=new Map(extra.saved?[['neuron-cli-login',JSON.stringify(extra.saved)]]:[]);const forms=[];let fetches=0;let subscription;let redirect;let replaced;
  const context=vm.createContext({URL,URLSearchParams,AbortSignal,Date,console,
    location:{search:extra.search??('?'+new URLSearchParams({callback_url:callback,state})),origin:'https://zero-x.live',pathname:'/neuroncli/login/'},history:{replaceState(_state,_title,value){replaced=value;}},
    sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    document:{getElementById:el,body:{appendChild(form){forms.push(form);}},createElement(){return {children:[],appendChild(child){this.children.push(child);},submit(){this.submitted=true;}};}},
    window:{ZeroXAuth:{async init(){},async getProfile(){return signedIn?{email:'owner@example.com'}:null;},async getAccessToken(){return 'identity-token';},onAuthStateChange(fn){subscription=fn;},async openAuthModal(options){redirect=options.redirectTo;}}},
    fetch:async(path,options)=>{fetches++;assert.equal(path,'/auth/cli/session');assert.equal(options.headers.Authorization,'Bearer identity-token');return new Response(JSON.stringify({session_token:sessionToken}));},
  });
  vm.runInContext(source,context);await drain();
  return {el,forms,storage,context,get fetches(){return fetches;},get redirect(){return redirect;},get replaced(){return replaced;},subscription};
}
for(const callback of ['https://evil.example/callback','http://localhost:4545/callback','http://127.0.0.1:4545/wrong','http://127.0.0.1:4545/callback?x=1','http://user@127.0.0.1:4545/callback']){
  const app=await run(callback);assert.equal(app.el('connect').hidden,true);assert.equal(app.fetches,0);assert.equal(app.forms.length,0);
}
const app=await run('http://127.0.0.1:4545/callback');
assert.equal(app.el('connect').textContent,'Connect this account');
assert.equal(app.fetches,0,'A signed-in user must explicitly connect the terminal');
await app.el('connect').click();
assert.equal(app.forms[0].method,'POST');assert.equal(app.forms[0].action,'http://127.0.0.1:4545/callback');assert.equal(app.forms[0].submitted,true);
assert.deepEqual(app.forms[0].children.map(input=>[input.name,input.value]),[['state',state],['session_token','ses_gateway']]);
assert.equal(app.storage.size,0);
const invalid=await run('http://127.0.0.1:4545/callback','sk_provider_key');await invalid.el('connect').click();
assert.equal(invalid.forms.length,0);assert.match(invalid.el('message').textContent,/invalid session/);assert.equal(invalid.el('connect').disabled,false);
const expired=await run('http://127.0.0.1:4545/callback');expired.context.window.ZeroXAuth.getAccessToken=async()=>'';await expired.el('connect').click();
assert.equal(expired.fetches,0);assert.match(expired.el('message').textContent,/expired/);
const unsigned=await run('http://127.0.0.1:4545/callback','ses_gateway',false);await unsigned.el('connect').click();
const redirect=new URL(unsigned.redirect);assert.equal(redirect.origin,'https://zero-x.live');assert.equal(redirect.searchParams.get('callback_url'),'http://127.0.0.1:4545/callback');assert.equal(redirect.searchParams.get('state'),state);
const returned=await run('http://127.0.0.1:4545/callback','ses_gateway',true,{search:redirect.search+'&code=supabase-auth-code'});
assert.equal(returned.replaced,'/neuroncli/login/?code=supabase-auth-code','OAuth codes must survive until Supabase initializes');
const restored=await run('', 'ses_gateway',true,{search:'?code=oauth',saved:{callback_url:'http://127.0.0.1:4545/callback',state,created:Date.now()}});
assert.equal(restored.el('connect').hidden,false);
const stale=await run('', 'ses_gateway',true,{search:'',saved:{callback_url:'http://127.0.0.1:4545/callback',state,created:Date.now()-601000}});
assert.equal(stale.el('connect').hidden,true);assert.match(stale.el('message').textContent,/expired/);
const html=readFileSync(new URL('../login/index.html',import.meta.url),'utf8');assert.match(html,/<meta name="referrer" content="origin">/,'POST Origin must be preserved for the Rust loopback validator');
console.log('PASS: account handoff, loopback validation, POST credentials, OAuth return/new-tab recovery, expiry, and retryable failures');

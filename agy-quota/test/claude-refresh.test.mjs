import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { locate } from '../patch.mjs';
import { claudeFixture } from '../claude-patch.mjs';
import { createClaudeCredentialReader, renewWithClaude, claudeProbeEnvironment } from '../src/claude-refresh.js';
const logger = { child() { return this; }, warn() {}, debug() {} };
const start = Date.parse('2026-09-20T09:00:00Z');
const old = { oauth: { accessToken: 'old-secret', refreshToken: 'refresh-secret', expiresAt: start - 1 } };
const fresh = { oauth: { accessToken: 'new-secret', refreshToken: 'rotated-secret', expiresAt: start + 8 * 3600000 } };

test('expired credentials coalesce refresh, re-read and use the new token', async () => {
  let value = old, calls = 0;
  const read = createClaudeCredentialReader(async () => value, { now: () => start, claudeHome: '/fake', state: new Map(), run: async () => { calls++; await new Promise(r => setTimeout(r, 5)); value = fresh; } });
  const results = await Promise.all(Array.from({ length: 12 }, () => read()));
  assert.equal(calls, 1);
  assert.ok(results.every(r => r.oauth.accessToken === 'new-secret'));
});

test('unchanged credentials and CLI failure cool down without leaking CLI output', async () => {
  for (const fail of [false, true]) {
    let calls = 0, now = start;
    const read = createClaudeCredentialReader(async () => old, { now: () => now, claudeHome: '/fake', state: new Map(), run: async () => { calls++; if(fail) throw Error('refresh-secret'); } });
    for(let i=0;i<3;i++) await assert.rejects(read(), e => !e.message.includes('secret') && /renewal/.test(e.message));
    assert.equal(calls, 1);
    now += 60000;
    await assert.rejects(read(), /renewal/);
    assert.equal(calls, 2);
  }
});

test('fresh, missing and non-refreshable credentials do not start CLI; externally refreshed credentials recover during cooldown', async () => {
  let calls=0,value=old;
  const read=createClaudeCredentialReader(async()=>value,{now:()=>start,claudeHome:'/fake',state:new Map(),run:async()=>{calls++;}});
  for(const v of [fresh,null,{oauth:{accessToken:'manual'}}]) {value=v;assert.equal(await read(),v);}
  assert.equal(calls,0);
  value=old;await assert.rejects(read());value=fresh;assert.equal(await read(),fresh);
  assert.equal(calls,1);
});

test('real patched provider retains expiry and refreshes before usage; 429 does not renew fresh credentials', async () => {
  const f=claudeFixture(locate());
  try {
    const {ClaudeQuotaProvider}=await import(f.module);
    const home=join(f.dir,'home');
    const {mkdirSync}=await import('node:fs');mkdirSync(home);
    const save=v=>writeFileSync(join(home,'.credentials.json'),JSON.stringify({claudeAiOauth:v.oauth}));
    save(old);let renewals=0,requests=0;
    const p=new ClaudeQuotaProvider({logger,claudeHome:home,platform:'linux',
      claudeRefreshOptions:{now:()=>start,run:async()=>{renewals++;save(fresh);}},
      quotaFetchOptions:{stateFile:join(f.dir,'gate.json'),now:()=>start},
      fetch:async(url,init)=>{requests++;assert.equal(init.headers.Authorization,'Bearer new-secret');return new Response('{}',{status:429});}
    });
    await assert.rejects(p.fetchUsage(),/429/);
    await assert.rejects(p.fetchUsage(),/429/);
    assert.equal(renewals,1);assert.equal(requests,1);
  }finally{f.cleanup();}
});

test('probe environment targets the same profile and removes alternate auth and nested-session flags',()=>{
 const env=claudeProbeEnvironment('/profile',{PATH:'/bin',ANTHROPIC_API_KEY:'secret',CLAUDE_CODE_OAUTH_TOKEN:'secret',ANTHROPIC_BASE_URL:'https://alternate',CLAUDECODE:'1',CLAUDE_CODE_USE_BEDROCK:'1',HTTPS_PROXY:'http://proxy'});
 assert.equal(env.CLAUDE_CONFIG_DIR,'/profile');assert.equal(env.HTTPS_PROXY,'http://proxy');
 for(const k of ['ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDECODE','CLAUDE_CODE_USE_BEDROCK'])assert.equal(env[k],undefined);
});

test('PTY probe times out, terminates its child, and never sends a model prompt',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'claude-renew-test-'));let args,writes=[],kills=[],exit;
 const child={pid:123,onData(){return{dispose(){}}},onExit(fn){exit=fn;return{dispose(){}}},write(s){writes.push(s)},kill(s){kills.push(s);exit?.({exitCode:0});}};
 try{
  await assert.rejects(renewWithClaude('/profile',{bin:'/fake/claude',cwd:dir,timeoutMs:20,read:async()=>old,now:()=>start,spawn:(bin,a)=>{args=a;return child;}}),/renewal/);
  assert.ok(args.includes('/status'));assert.ok(args.includes('--strict-mcp-config'));assert.ok(kills.length);
  assert.equal(writes.length,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('separate providers sharing a profile join one renewal attempt', async () => {
  const state = new Map(); let value = old, calls = 0;
  const options = {claudeHome:'/shared-profile',state,now:()=>start,run:async()=>{calls++;await new Promise(r=>setTimeout(r,5));value=fresh;}};
  const a=createClaudeCredentialReader(async()=>value,options);
  const b=createClaudeCredentialReader(async()=>value,options);
  await Promise.all([a(),b(),a(),b()]);assert.equal(calls,1);
});

test('PTY status alone is not renewal success; fresh credentials plus status succeed and clean up', async () => {
  for (const value of [old,fresh]) {
    const dir=mkdtempSync(join(tmpdir(),'claude-renew-status-'));let onExit,killed=false;
    const child={onData(fn){queueMicrotask(()=>fn('Version:2.1.274\nLogin method:Claude Pro account'));return{dispose(){}}},onExit(fn){onExit=fn;return{dispose(){}}},write(){},kill(){killed=true;onExit({exitCode:0});}};
    try {
      const result=renewWithClaude('/profile',{bin:'/fake/claude',cwd:dir,timeoutMs:30,read:async()=>value,now:()=>start,spawn:()=>child});
      if(value===old)await assert.rejects(result,/renewal/);else await result;
      assert.equal(killed,true);
    }finally{rmSync(dir,{recursive:true,force:true});}
  }
});


test('default profile preserves ~/.claude.json; explicit profiles preserve their config location', () => {
  const home = join(homedir(), '.claude');
  assert.equal(claudeProbeEnvironment(home, {}).CLAUDE_CONFIG_DIR, undefined);
  assert.equal(claudeProbeEnvironment(home, { CLAUDE_CONFIG_DIR: home }).CLAUDE_CONFIG_DIR, home);
});

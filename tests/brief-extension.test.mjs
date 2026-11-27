import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { destinationIdentity } from '../lib/brief-reference.mjs';
const host = process.env.SCOUT_PI_SDK_ROOT;
const product = fileURLToPath(new URL('../', import.meta.url));
const enabled = { skip: !host && 'Requires existing Pi SDK' };
test('native local save/read and trusted peer resolver enforce branch, destination, lifecycle and exact evidence', enabled, async t => {
  const root = await mkdtemp(join(tmpdir(), 'scout-native-ref-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = Object.fromEntries(['PI_SCOUT_BRIEFS','PI_SCOUT_CATALOG','PI_SCOUT_WEB_PROFILE'].map(k=>[k,process.env[k]]));
  process.env.PI_SCOUT_BRIEFS = join(root, 'briefs');
  delete process.env.PI_SCOUT_CATALOG; delete process.env.PI_SCOUT_WEB_PROFILE;
  t.after(() => { for(const [k,v] of Object.entries(before)) v === undefined ? delete process.env[k] : process.env[k]=v; });
  const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(resolve(host,'dist/core/extensions/loader.js')));
  const { createEventBus } = await import(pathToFileURL(resolve(host,'dist/core/event-bus.js')));
  const bus = createEventBus(), runtime = createExtensionRuntime(), entries = [];
  runtime.appendEntry = (customType, data) => entries.push({type:'custom',customType,data});
  const loaded = await loadExtensions([join(product,'extension/index.ts'),join(product,'extension/briefs.ts')],root,bus,runtime);
  assert.deepEqual(loaded.errors, []);
  const [local, reader] = loaded.extensions;
  const versions = [];
  bus.emit('pi-daddy:ecosystem-versions:v1',{report:value=>versions.push(value)});
  const declaredVersion = JSON.parse(await readFile(join(product, 'package.json'), 'utf8')).version;
  assert.deepEqual(versions.map(({id,version})=>({id,version})),[{id:'pi-scout-research',version:declaredVersion}]);
  let endpoint = 'https://provider.example/v1', branch = entries;
  const ctx = { cwd:root, model:{provider:'fixture',id:'model',api:'fixture',baseUrl:endpoint},
    modelRegistry:{getApiKeyAndHeaders:async()=>({ok:true,baseUrl:endpoint,apiKey:'never-retained'})},
    sessionManager:{getSessionId:()=> 'source-session',getBranch:()=>branch} };
  const invoke = (extension,name,args) => extension.tools.get(name).definition.execute('call',args,new AbortController().signal,undefined,ctx);
  const localSources = local.tools.get('research_sources').definition;
  assert.match(localSources.description, /separate from scout_research worker sources/);
  assert.match(localSources.description, /empty list is valid/);
  const emptyCatalog = await invoke(local, 'research_sources', {});
  assert.deepEqual(emptyCatalog.details, []);
  assert.deepEqual(JSON.parse(emptyCatalog.content[0].text), []);
  assert.equal(emptyCatalog.isError, undefined);
  const saved = (await invoke(local,'research_brief',{question:'Fixture only',scope:'Selected sources',questions:[],doneWhen:'Return gaps',findings:[],gaps:['Unknown']})).details;
  assert.equal(saved.saved,true);
  assert.equal(entries[0].customType,'scout-brief-v2');
  assert.equal(JSON.stringify(entries).includes('Fixture only'),false);
  const read = await invoke(reader,'scout_brief_read',{reference:saved.reference});
  assert.equal(read.details.complete,true);
  assert.match(read.details.excerpt,/Fixture only/);
  const [hook] = local.handlers.get('context');
  const restored = await hook({messages:[]},ctx);
  assert.equal(restored.messages[0].content.includes('Fixture only'),false);
  const placed = await hook({messages:[{role:'user',content:'Save'},{role:'toolResult',toolCallId:'call',toolName:'research_brief',details:saved},
    {role:'assistant',content:[]},{role:'user',content:'Continue'}]},ctx);
  assert.deepEqual(placed.messages.map(message=>message.customType??message.role),['user','toolResult','scout-brief-context','assistant','user']);
  assert.equal(placed.messages[2].content,restored.messages[0].content);
  endpoint = 'https://different.example/v1';
  assert.equal((await invoke(reader,'scout_brief_read',{reference:saved.reference})).details.status,'denied');
  endpoint = 'https://provider.example/v1'; branch = [];
  assert.equal((await invoke(reader,'scout_brief_read',{reference:saved.reference})).details.status,'denied');
  for (const h of reader.handlers.get('session_start')) await h({},ctx);
  const resolveRef = (extra={}) => new Promise(reply=>bus.emit('scout:resolve:v1',{version:1,requestId:'fixture',sessionId:'source-session',cwd:root,reference:saved.reference,reply,...extra}));
  assert.equal((await resolveRef()).status,'denied');
  const target = await destinationIdentity(ctx);
  const exact = ({reference,destination}) => JSON.stringify(reference)===JSON.stringify(saved.reference) && JSON.stringify(destination)===JSON.stringify(target);
  const resolved = await resolveRef({authorize:exact});
  assert.equal(resolved.ok,true);
  assert.equal(resolved.sessionId,'source-session');
  assert.equal(resolved.cwd,root);
  await resolved.assertCurrent();
  assert.equal((await resolveRef({sessionId:'wrong',authorize:exact})).status,'denied');
  endpoint = 'https://different.example/v1';
  await assert.rejects(resolved.assertCurrent(),/no longer/);
  endpoint = 'https://provider.example/v1';
  const again = await resolveRef({authorize:exact});
  let switched = false;
  const raced = await resolveRef({authorize:async details=>{
    if (!switched) {
      switched = true;
      for(const h of reader.handlers.get('session_tree')) await h({},ctx);
    }
    return exact(details);
  }});
  assert.equal(raced.status,'denied');
  assert.equal('excerpt' in raced,false);
  for (const h of reader.handlers.get('session_shutdown')) await h({},ctx);
  await assert.rejects(again.assertCurrent(),/no longer/);
  assert.equal((await resolveRef({authorize:exact})).status,'denied');
});

test('assigned specialist can read attached Scout brief across configured local model and emits attribution', enabled, async t => {
  const root = await mkdtemp(join(tmpdir(), 'scout-specialist-ref-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = process.env.PI_SCOUT_BRIEFS;
  process.env.PI_SCOUT_BRIEFS = join(root, 'briefs');
  t.after(() => { before === undefined ? delete process.env.PI_SCOUT_BRIEFS : process.env.PI_SCOUT_BRIEFS = before; });
  const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(resolve(host,'dist/core/extensions/loader.js')));
  const { createEventBus } = await import(pathToFileURL(resolve(host,'dist/core/event-bus.js')));
  const bus = createEventBus(), runtime = createExtensionRuntime(), entries = [];
  runtime.appendEntry = (customType, data) => entries.push({type:'custom',customType,data});
  const loaded = await loadExtensions([join(product,'extension/index.ts'),join(product,'extension/briefs.ts')],root,bus,runtime);
  assert.deepEqual(loaded.errors, []);
  const [local, reader] = loaded.extensions;
  const primaryModel = { provider:'fixture', id:'primary', api:'fixture', baseUrl:'https://provider.example/v1' };
  const localModel = { provider:'ollama', id:'qwen3:32b', api:'openai', baseUrl:'http://127.0.0.1:11434/v1' };
  const ctx = {
    cwd: root,
    model: primaryModel,
    modelRegistry: {
      find: (p, id) => (p === 'ollama' && id === 'qwen3:32b' ? localModel : p === 'fixture' && id === 'primary' ? primaryModel : undefined),
      hasConfiguredAuth: () => true,
      getApiKeyAndHeaders: async (m) => ({ ok: Boolean(m), baseUrl: m?.baseUrl, apiKey: 'never-retained' }),
    },
    sessionManager: { getSessionId: () => 'specialist-session', getBranch: () => entries },
  };
  for (const h of reader.handlers.get('session_start')) await h({}, ctx);
  const saved = (await local.tools.get('research_brief').definition.execute('c1', {
    question: 'Check API', scope: 'Docs', questions: [], doneWhen: 'Done', findings: [], gaps: ['None'],
  }, new AbortController().signal, undefined, ctx)).details;
  const events = [];
  bus.on('pi-daddy:ecosystem-activity:v1', (ev) => events.push(ev));
  const askSpecialist = (extra = {}) => new Promise(reply => bus.emit('scout:specialist-brief-read:v1', {
    version: 1, requestId: 'req-1', sessionId: 'specialist-session', cwd: root,
    specialist: 'investigate', childModel: 'ollama/qwen3:32b',
    attachedBriefSha256: [saved.reference.sha256], reference: saved.reference, reply, ...extra,
  }));
  const ok = await askSpecialist();
  assert.equal(ok.ok, true);
  assert.equal(ok.result.specialist, 'investigate');
  assert.match(ok.result.excerpt, /Check API/);
  assert.ok(events.some(e => e.specialist === 'investigate' && /investigate read brief/.test(e.detail)));
  // Unattached brief is denied
  const unattached = await askSpecialist({ attachedBriefSha256: ['0'.repeat(64)] });
  assert.equal(unattached.ok, false);
  assert.equal(unattached.status, 'denied');
  // Unconfigured destination model is denied
  const badDest = await askSpecialist({ childModel: 'unknown/model' });
  assert.equal(badDest.ok, false);
  assert.equal(badDest.status, 'denied');
  // Wrong workspace is denied
  const wrongCwd = await askSpecialist({ cwd: tmpdir() });
  assert.equal(wrongCwd.ok, false);
  assert.equal(wrongCwd.status, 'denied');
});

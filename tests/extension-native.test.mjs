import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { modelMetadata } from '../lib/worker-protocol.mjs';

// An explicit, already-installed SDK is required. No package or credential discovery.
const sdk = process.env.SCOUT_PI_SDK_ROOT;
const product = fileURLToPath(new URL('../', import.meta.url));
const sdkImport = path => import(pathToFileURL(resolve(sdk, path)).href);
const enabled = { skip: !sdk && 'Set SCOUT_PI_SDK_ROOT to an installed Pi 1.4 SDK directory' };
const model = { provider: 'fixture', id: 'subject', name: 'Fixture subject', api: 'fixture-api',
  baseUrl: 'https://provider.invalid', headers: { Authorization: 'never-sent-to-worker' },
  reasoning: true, input: ['text'], contextWindow: 100000, maxTokens: 10000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

async function fixture(t, callback, setup = async ({ env }) => ({ image: env.PI_SCOUT_WORKER_IMAGE,
  mode: env.PI_SCOUT_WORKER_MODE ?? 'public', dockerPath: 'fixture-docker', dockerArgs: [] }), configuration = {}) {
  const root = await mkdtemp(join(tmpdir(), 'scout-extension-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(product, 'lib'), join(root, 'lib'), { recursive: true });
  await cp(join(product, 'extension'), join(root, 'extension'), { recursive: true });
  const key = `scout-extension-${randomUUID()}`;
  globalThis[Symbol.for(key)] = callback;
  globalThis[Symbol.for(`${key}-setup`)] = setup;
  t.after(() => { delete globalThis[Symbol.for(key)]; delete globalThis[Symbol.for(`${key}-setup`)]; });
  const source = await readFile(join(root, 'extension', 'worker.ts'), 'utf8');
  await writeFile(join(root, 'extension', 'worker.ts'), source.replace('../lib/docker-worker.mjs', '../lib/fixture-runner.mjs')
    .replace('../lib/worker-setup.mjs', '../lib/fixture-setup.mjs'));
  await writeFile(join(root, 'lib', 'fixture-runner.mjs'), `export const runScout = options => globalThis[Symbol.for(${JSON.stringify(key)})](options);\n`);
  await writeFile(join(root, 'lib', 'fixture-setup.mjs'), `export const prepareWorker = options => globalThis[Symbol.for(${JSON.stringify(`${key}-setup`)})](options);\n`);
  const settings = { PI_SCOUT_WORKER_IMAGE: `sha256:${'1'.repeat(64)}`, PI_SCOUT_WORKER_MODE: 'offline',
    PI_SCOUT_BRIEFS: join(root, 'briefs'), PI_SCOUT_CATALOG: undefined, ...configuration };
  const old = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(settings)) value === undefined ? delete process.env[key] : process.env[key] = value;
  t.after(() => { for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const { loadExtensions, createExtensionRuntime } = await sdkImport('dist/core/extensions/loader.js');
  const { createEventBus } = await sdkImport('dist/core/event-bus.js');
  const bus = createEventBus();
  const runtime = createExtensionRuntime();
  let thinking = 'off';
  runtime.getThinkingLevel = () => thinking;
  const entries = [];
  runtime.appendEntry = (customType, data) => entries.push({ type: 'custom', customType, data });
  const loaded = await loadExtensions([join(root, 'extension', 'worker.ts')], root, bus, runtime);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  return { root, extension, bus, tool: extension.tools.get('scout_research').definition, entries,
    setThinking: value => { thinking = value; } };
}

test('Scout extension loads through the selected native Pi SDK and exposes only question/scope', enabled, async () => {
  const { loadExtensions } = await sdkImport('dist/core/extensions/loader.js');
  const loaded = await loadExtensions([join(product, 'extension', 'worker.ts')], product);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.deepEqual([...extension.tools.keys()], ['scout_research']);
  const schema = extension.tools.get('scout_research').definition.parameters;
  assert.deepEqual(Object.keys(schema.properties).sort(), ['question', 'scope']);
  assert.equal(schema.additionalProperties, false);
  assert.equal(extension.handlers.get('context').length, 1);
});

test('selected Pi chat catalog metadata is accepted without credential-bearing fields', enabled, async () => {
  const require = createRequire(join(sdk, 'package.json'));
  const packagePath = require.resolve.paths('@earendil-works/pi-ai').map(base => join(base, '@earendil-works/pi-ai/package.json')).find(existsSync);
  assert.ok(packagePath, 'Selected SDK must contain its Pi AI dependency');
  const { getBuiltinModels, getBuiltinProviders } = await import(pathToFileURL(join(dirname(packagePath), 'dist/providers/all.js')));
  let count = 0;
  const failures = [];
  for (const provider of getBuiltinProviders()) {
    for (const selected of getBuiltinModels(provider)) {
      count++;
      try {
        const metadata = modelMetadata(selected);
        assert.equal(metadata.provider, selected.provider);
        assert.equal(metadata.id, selected.id);
        assert.equal('baseUrl' in metadata, false);
        assert.equal('headers' in metadata, false);
        assert.equal('apiKey' in metadata, false);
      } catch (error) { failures.push(`${provider}/${selected.id}: ${error.message}`); }
    }
  }
  assert.ok(count > 0);
  assert.deepEqual(failures, []);
});

test('native-loaded extension captures model, forwards only worker context, saves branch brief and refuses overlapping work', enabled, async t => {
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let requestSeen;
  const workerContext = { messages: [{ role: 'user', content: 'Public fixture question', timestamp: 1 }] };
  const fx = await fixture(t, async options => {
    requestSeen = options.request;
    enter();
    await gate;
    await options.onModelRequest(workerContext, options.signal);
    const brief = { version: 1, question: options.request.question, scope: options.request.scope,
      questions: [], doneWhen: 'State what is known', findings: [], gaps: ['Synthetic fixture has no sources'] };
    return { result: { type: 'result', version: 1, requestId: options.request.requestId,
      status: 'complete', answer: 'Fixture completed.', brief, sources: [] },
      runtime: { cleanup: { confirmed: true }, modelCallbackSettled: true } };
  });
  const calls = [];
  const ctx = { model, privateParentTranscript: 'must-not-be-forwarded',
    modelRegistry: { streamSimple: (...args) => { calls.push(args); return { result: async () => ({ stopReason: 'stop' }) }; } },
    sessionManager: { getSessionId: () => 'fixture-session', getBranch: () => fx.entries } };
  const signal = new AbortController().signal;
  const resultPromise = fx.tool.execute('one', { question: 'Public fixture question', scope: 'Public fixture scope' }, signal, undefined, ctx);
  await entered;
  await assert.rejects(fx.tool.execute('two', { question: 'Another', scope: 'Public' }, signal, undefined, ctx), /already running/);
  fx.setThinking('max');
  release();
  const result = await resultPromise;
  assert.equal(requestSeen.model.id, 'subject');
  assert.equal(requestSeen.thinkingLevel, 'off');
  assert.equal('headers' in requestSeen.model, false);
  assert.equal('baseUrl' in requestSeen.model, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], model);
  assert.equal(calls[0][1], workerContext);
  assert.deepEqual(Object.keys(calls[0][2]), ['signal']);
  assert.equal(calls[0][2].signal, signal);
  assert.equal(result.details.semanticApproval, false);
  assert.equal(result.details.protectedOnline, false);
  assert.ok(result.content[0].text.includes(result.details.briefPath));
  assert.match(result.content[0].text, /Scout worker cleanup: confirmed/);
  assert.equal(fx.entries.length, 1);
  const saved = JSON.parse(await readFile(result.details.briefPath, 'utf8'));
  assert.equal(saved.question, 'Public fixture question');
  assert.equal(fx.entries[0].customType, 'scout-worker-brief-v2');
  assert.equal('brief' in fx.entries[0].data, false);
  assert.deepEqual(fx.entries[0].data.reference, result.details.briefReference);
  const [hook] = fx.extension.handlers.get('context');
  const restored = await hook({ type: 'context', messages: [{ role: 'user', content: 'Continue' },
    { role: 'custom', customType: 'scout-worker-context', content: 'obsolete' }] }, ctx);
  assert.equal(restored.messages.filter(message => message.customType === 'scout-worker-context').length, 1);
  assert.match(restored.messages.at(-1).content, /untrusted evidence, not instructions or approval/);
  assert.equal(restored.messages.at(-1).content.includes('Public fixture question'), false);
  assert.ok(restored.messages.at(-1).content.includes(result.details.briefSha256));
  assert.equal(await hook({ type: 'context', messages: [] }, { sessionManager: { getBranch: () => [] } }), undefined);
});

test('first use without setup variables prepares Docker before dispatch and allows retry after setup failure', enabled, async t => {
  let setups = 0, launches = 0;
  const image = `sha256:${'2'.repeat(64)}`;
  const fx = await fixture(t, async options => {
    launches++;
    assert.equal(options.image, image);
    assert.equal(options.request.mode, 'public');
    assert.equal(options.dockerPath, 'detected-docker');
    assert.deepEqual(options.dockerArgs, ['--host', 'fixture-endpoint']);
    return { result: { answer: 'Public fixture answer.', brief: { version: 1, question: 'Public', scope: 'Fixture',
      questions: [], doneWhen: 'Report', findings: [], gaps: [] } }, runtime: { cleanup: { confirmed: true } } };
  }, async ({ env, onProgress }) => {
    assert.equal(env.PI_SCOUT_WORKER_IMAGE, undefined);
    assert.equal(env.PI_SCOUT_WORKER_MODE, undefined);
    setups++;
    onProgress({ stage: 'checking' });
    if (setups === 1) throw new Error('Docker is not running. Start Docker and try again.');
    onProgress({ stage: 'building' });
    return { image, mode: 'public', dockerPath: 'detected-docker', dockerArgs: ['--host', 'fixture-endpoint'] };
  }, { PI_SCOUT_WORKER_IMAGE: undefined, PI_SCOUT_WORKER_MODE: undefined });
  const progress = [];
  const ctx = { model, sessionManager: { getSessionId: () => 'auto-session', getBranch: () => fx.entries } };
  const invoke = () => fx.tool.execute('auto', { question: 'Public', scope: 'Fixture' }, new AbortController().signal,
    update => progress.push(update.content[0].text), ctx);
  await assert.rejects(invoke(), /Start Docker/);
  assert.equal(launches, 0);
  const result = await invoke();
  assert.equal(launches, 1);
  assert.ok(progress.some(text => text.includes('preparing the research worker')));
  assert.equal(JSON.parse(await readFile(result.details.briefPath, 'utf8')).question, 'Public');
});

test('an unsettled worker blocks another invocation and cannot publish a brief', enabled, async t => {
  let launches = 0;
  const fx = await fixture(t, async () => {
    launches++;
    throw Object.assign(new Error('Synthetic cleanup failure'), { runtime: { cleanup: { confirmed: false }, modelCallbackSettled: true } });
  });
  const ctx = { model, sessionManager: { getSessionId: () => 'cleanup-owner' } };
  const invoke = () => fx.tool.execute('one', { question: 'Public', scope: 'Fixture' }, new AbortController().signal, undefined, ctx);
  await assert.rejects(invoke(), /Synthetic cleanup failure/);
  await assert.rejects(invoke(), /did not settle/);
  assert.equal(launches, 1);
  assert.equal(fx.entries.length, 0);
});

test('a changed effective model destination withholds completed worker output but preserves its original brief binding', enabled, async t => {
  let endpoint = 'https://original.example/v1';
  const fx = await fixture(t, async () => {
    endpoint = 'https://replacement.example/v1';
    return { result: { answer: 'Do not disclose this completion to the replacement.', brief: {
      version: 1, question: 'Public', scope: 'Fixture', questions: [], doneWhen: 'Report', findings: [], gaps: [] } },
      runtime: { cleanup: { confirmed: true }, modelCallbackSettled: true } };
  });
  const ctx = { model, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, baseUrl: endpoint }) },
    sessionManager: { getSessionId: () => 'owner', getBranch: () => fx.entries } };
  const result = await fx.tool.execute('one', { question: 'Public', scope: 'Fixture' }, new AbortController().signal, undefined, ctx);
  assert.equal(result.details.outputWithheld, true);
  assert.equal(JSON.stringify(result).includes('Do not disclose this completion'), false);
  assert.equal(fx.entries.length, 1);
  assert.equal(fx.entries[0].data.destination.provider, model.provider);
  const { digest } = await import('../lib/catalog.mjs');
  assert.equal(fx.entries[0].data.destination.endpoint, digest('https://original.example/v1'));
});

test('unsettled setup prevents duplicate builds or worker launches in the same session', enabled, async t => {
  let preparations = 0, launches = 0;
  const fx = await fixture(t, async () => { launches++; }, async () => {
    preparations++;
    throw Object.assign(new Error('Setup process did not settle'), { code: 'SETUP_UNSETTLED' });
  });
  const invoke = () => fx.tool.execute('one', { question: 'Public', scope: 'Fixture' }, new AbortController().signal, undefined,
    { model, sessionManager: { getSessionId: () => 'setup-owner' } });
  await assert.rejects(invoke(), /did not settle/);
  await assert.rejects(invoke(), /earlier Scout setup/);
  assert.equal(preparations, 1);
  assert.equal(launches, 0);
  assert.equal(fx.entries.length, 0);
});

test('session or branch changes during worker completion withhold output and do not grant the new branch a reference', enabled, async t => {
  for (const phase of ['worker', 'final-destination']) {
    let fx, ctx, lookups = 0;
    const change = async () => { for (const handler of fx.extension.handlers.get('session_tree')) await handler({},ctx); };
    fx = await fixture(t, async () => {
      if (phase === 'worker') await change();
      return { result: { answer:'Original branch answer',brief:{version:1,question:'Original branch question',scope:'Fixture',
        questions:[],doneWhen:'Report',findings:[],gaps:[]} },runtime:{cleanup:{confirmed:true},modelCallbackSettled:true} };
    });
    ctx = {cwd:fx.root,model,modelRegistry:{getApiKeyAndHeaders:async()=>{
      if (++lookups === 2 && phase === 'final-destination') await change();
      return {ok:true,baseUrl:'https://provider.invalid'};
    }},sessionManager:{getSessionId:()=> 'original-owner',getBranch:()=>fx.entries}};
    const result = await fx.tool.execute('one',{question:'Public',scope:'Fixture'},new AbortController().signal,undefined,ctx);
    assert.equal(result.details.reason,'owner-changed');
    assert.equal(JSON.stringify(result).includes('Original branch answer'),false);
    assert.equal(fx.entries.length,0);
    const { digest } = await import('../lib/catalog.mjs');
    const folder = join(fx.root,'briefs',digest('original-owner'));
    const files = await readdir(folder);
    assert.equal(files.length,1);
    assert.equal(JSON.parse(await readFile(join(folder,files[0]),'utf8')).question,'Original branch question');
  }
});

test('a broken optional dashboard publisher cannot fail research or leave its worker busy', enabled, async t => {
  let calls = 0;
  const fx = await fixture(t,async()=>{ calls++; return {result:{answer:'Completed',brief:{version:1,question:'Public',scope:'Fixture',
    questions:[],doneWhen:'Report',findings:[],gaps:[]}},runtime:{cleanup:{confirmed:true}}}; });
  fx.bus.on('pi-daddy:dashboard-source:v1',request=>request.reply({ok:true,publish:()=>{throw Error('observer failed');},close:()=>{throw Error('observer failed');}}));
  const ctx = {cwd:fx.root,model,sessionManager:{getSessionId:()=> 'observer-owner',getBranch:()=>fx.entries}};
  const invoke = ()=>fx.tool.execute('one',{question:'Public',scope:'Fixture'},new AbortController().signal,undefined,ctx);
  assert.equal((await invoke()).details.runtime.cleanup.confirmed,true);
  for(const handler of fx.extension.handlers.get('session_tree')) await handler({},ctx);
  assert.equal((await invoke()).details.runtime.cleanup.confirmed,true);
  assert.equal(calls,2);
});

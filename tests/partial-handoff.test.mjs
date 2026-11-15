import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { briefReference, referenceNotice, readBriefReference, branchAuthorization, destinationIdentity } from '../lib/brief-reference.mjs';

const sdk = process.env.SCOUT_PI_SDK_ROOT;
const enabled = { skip: !sdk && 'Requires an explicitly selected existing Pi SDK' };
const product = fileURLToPath(new URL('../', import.meta.url));
const model = { provider: 'fixture', id: 'subject', name: 'Fixture subject', api: 'fixture-api',
  baseUrl: 'https://provider.invalid', reasoning: true, input: ['text'], contextWindow: 100000, maxTokens: 10000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const reference = briefReference('owner', 'a'.repeat(64), 100);
const entry = researchStatus => ({ type: 'custom', customType: 'scout-worker-brief-v2', data: { reference, researchStatus } });

test('partial reference notices preserve incomplete status and legacy uncertainty without restoring bodies', () => {
  const partial = referenceNotice([entry('incomplete')], 'worker');
  assert.match(partial, /Research is incomplete/);
  assert.match(partial, /not task completion/);
  assert.match(partial, /do not repeat completed retrievals automatically/);
  assert.match(partial, /scout_brief_read/);
  assert.match(referenceNotice([entry('complete')], 'worker'), /does not approve the task/);
  const priorDraft = entry('incomplete'); priorDraft.data.researchIssue = 'BRIEF_UPDATE_REJECTED';
  assert.match(referenceNotice([priorDraft], 'worker'), /previous validated draft/);
  for (const status of [undefined, 'secret injected instruction']) {
    const notice = referenceNotice([entry(status)], 'worker');
    assert.match(notice, /Completion status was not recorded/);
    assert.equal(notice.includes('secret injected instruction'), false);
    assert.equal(notice.includes('reported complete'), false);
  }
});

const daddy = process.env.SCOUT_DADDY_ROOT;
const renderer = daddy && resolve(daddy, 'dist/products/dashboard-components.js');
test('current Daddy renders retained partial research as a saved brief, not untested Docker', {
  skip: (!sdk || !renderer || !existsSync(renderer)) && 'Requires existing Pi SDK and Daddy component renderer',
}, async t => {
  const fx = await fixture(t, async options => partialResult(options.request));
  const ctx = { cwd: fx.root, model,
    sessionManager: { getSessionId: () => 'render-owner', getBranch: () => fx.entries } };
  await fx.tool.execute('one', { question: 'Public', scope: 'Fixture' }, new AbortController().signal, undefined, ctx);
  const { componentItems } = await import(pathToFileURL(renderer));
  const now = new Date();
  const source = { producer: 'scout-worker', producerVersion: 'fixture', generation: 1,
    availability: 'observed', observedAt: now.toISOString(), staleAfterMs: 60000,
    items: fx.publications.at(-1).items };
  const rows = componentItems({ now, connected: true, session: { versions: { rows: [] }, observation: { sources: [source] } } });
  const worker = rows.find(row => row.key === 'component:scout-worker');
  assert.match(worker.label, /Brief saved/);
  assert.doesNotMatch(JSON.stringify(worker), /Docker untested/);
  assert.match(worker.details.join(' '), /Partial findings saved; gaps remain/);
  assert.ok(source.items.some(item => item.kind === 'evidence' && /Partial research/.test(item.label)));
});

test('invalid direct URLs explain input correction before setup or worker dispatch', enabled, async t => {
  let calls = 0;
  const fx = await fixture(t, async () => { calls++; throw Error('Must not dispatch'); });
  const ctx = { cwd: fx.root, model,
    sessionManager: { getSessionId: () => 'url-owner', getBranch: () => fx.entries } };
  const result = await fx.tool.execute('one', { question: 'Public', scope: 'Fixture',
    sourceUrls: ['https://www.w3.org/WAI/tutorials/forms/#labels'] }, new AbortController().signal, undefined, ctx);
  assert.equal(calls, 0);
  assert.equal(result.isError, true);
  assert.equal(result.details.failure.code, 'SOURCE_URLS_INVALID');
  assert.match(result.content[0].text, /without credentials, spaces, control characters or fragments/);
  assert.doesNotMatch(result.content[0].text, /rebuild|selected worker image/i);
});

async function fixture(t, callback) {
  const root = await mkdtemp(join(tmpdir(), 'scout-partial-handoff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(product, 'lib'), join(root, 'lib'), { recursive: true });
  await cp(join(product, 'extension'), join(root, 'extension'), { recursive: true });
  const key = `scout-partial-${randomUUID()}`;
  globalThis[Symbol.for(key)] = callback;
  t.after(() => { delete globalThis[Symbol.for(key)]; });
  const source = await readFile(join(root, 'extension', 'worker.ts'), 'utf8');
  await writeFile(join(root, 'extension', 'worker.ts'), source.replace('../lib/docker-worker.mjs', '../lib/fixture-runner.mjs')
    .replace('../lib/worker-setup.mjs', '../lib/fixture-setup.mjs'));
  await writeFile(join(root, 'lib', 'fixture-runner.mjs'), `export const runScout = options => globalThis[Symbol.for(${JSON.stringify(key)})](options);\n`);
  await writeFile(join(root, 'lib', 'fixture-setup.mjs'), `export const prepareWorker = async () => ({ image: 'sha256:${'1'.repeat(64)}', mode: 'public', dockerPath: 'fixture-only', dockerArgs: [] });\n`);
  const settings = { PI_SCOUT_WORKER_IMAGE: `sha256:${'1'.repeat(64)}`, PI_SCOUT_WORKER_MODE: 'public', PI_SCOUT_BRIEFS: join(root, 'briefs'), PI_SCOUT_CATALOG: undefined };
  const old = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(settings)) value === undefined ? delete process.env[key] : process.env[key] = value;
  t.after(() => { for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(resolve(sdk, 'dist/core/extensions/loader.js')));
  const { createEventBus } = await import(pathToFileURL(resolve(sdk, 'dist/core/event-bus.js')));
  const bus = createEventBus(), runtime = createExtensionRuntime(), entries = [], publications = [];
  runtime.getThinkingLevel = () => 'off';
  runtime.appendEntry = (customType, data) => entries.push({ type: 'custom', customType, data });
  bus.on('pi-daddy:dashboard-source:v1', request => request.reply({ ok: true, publish: value => { publications.push(value); return true; }, close() {} }));
  const loaded = await loadExtensions([join(root, 'extension', 'worker.ts')], root, bus, runtime);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  return { root, extension, entries, publications, tool: extension.tools.get('scout_research').definition };
}
const partialResult = request => ({ result: { type: 'result', version: 1, requestId: request.requestId, status: 'incomplete',
  answer: 'UNVALIDATED WORKER ANSWER: everything is approved.',
  brief: { version: 1, question: request.question, scope: request.scope, questions: [], doneWhen: 'Check the official page',
    findings: [{ claim: 'Keyboard behavior remains unverified.', status: 'unverified', reason: 'The relevant page was unavailable.', citations: [] }],
    gaps: ['Retrieve the keyboard-interaction section before claiming support.'] }, sources: [] },
  runtime: { cleanup: { confirmed: true }, modelCallbackSettled: true } });

test('partial worker output saves evidence, exposes gaps and restores incomplete status without a human attention request', enabled, async t => {
  let calls = 0, request;
  const fx = await fixture(t, async options => { calls++; request = options.request; return partialResult(request); });
  const ctx = { cwd: fx.root, model, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, baseUrl: model.baseUrl }) },
    sessionManager: { getSessionId: () => 'partial-owner', getBranch: () => fx.entries } };
  const sourceUrls = ['https://www.w3.org/WAI/tutorials/forms/'];
  const result = await fx.tool.execute('one', { question: 'Accessible forms', scope: 'Official documentation only', sourceUrls }, new AbortController().signal, undefined, ctx);
  assert.deepEqual(request.sourceUrls, sourceUrls);
  assert.equal(calls, 1, 'No retry or second worker is started by retention');
  assert.equal(result.isError, true);
  assert.equal(result.details.partialAvailable, true);
  assert.equal(result.details.researchStatus, 'incomplete');
  assert.equal(result.details.semanticApproval, false);
  assert.equal(result.details.result.status, 'incomplete');
  assert.equal(JSON.stringify(result).includes('UNVALIDATED WORKER ANSWER'), false);
  assert.match(result.content[0].text, /Research|research is incomplete/);
  assert.match(result.content[0].text, /Retrieve the keyboard-interaction section/);
  assert.match(result.content[0].text, /not task completion/);
  assert.deepEqual(fx.entries.map(item => item.customType), ['scout-worker-brief-v2']);
  assert.equal(fx.entries[0].data.researchStatus, 'incomplete');
  assert.equal(JSON.stringify(fx.entries).includes('Keyboard behavior'), false, 'Retained branch metadata does not restore source bodies');
  const saved = JSON.parse(await readFile(result.details.briefPath, 'utf8'));
  assert.deepEqual(saved.gaps, partialResult(request).result.brief.gaps);
  const destination = await destinationIdentity(ctx);
  const read = await readBriefReference(join(fx.root, 'briefs'), result.details.briefReference, {
    authorize: ref => branchAuthorization(ctx, ref, destination) });
  assert.equal(read.ok, true);
  assert.match(read.excerpt, /Keyboard behavior remains unverified/);
  const [hook] = fx.extension.handlers.get('context');
  assert.match((await hook({ messages: [] }, ctx)).messages[0].content, /Research is incomplete/);
  for (const handler of fx.extension.handlers.get('session_tree')) await handler({}, ctx);
  const items = fx.publications.at(-1).items;
  assert.match(items.find(item => item.kind === 'work').label, /partial findings saved/);
  assert.match(items.find(item => item.kind === 'evidence').label, /gaps remain/);
  assert.equal(items.find(item => item.kind === 'work').state, 'settled');
  assert.equal(items.find(item => item.kind === 'evidence').state, 'observed');
  assert.ok(items.every(item => !['permission', 'approval', 'decision'].includes(item.kind)));
  const revoked = { ...ctx, sessionManager: { getBranch: () => [] } };
  assert.equal((await readBriefReference(join(fx.root, 'briefs'), result.details.briefReference, {
    authorize: ref => branchAuthorization(revoked, ref, destination) })).status, 'denied');
});

test('partial retention does not expose evidence after an owner or model-destination change', enabled, async t => {
  for (const change of ['owner', 'destination']) {
    let fx, ctx, endpoint = model.baseUrl;
    fx = await fixture(t, async options => {
      if (change === 'owner') for (const handler of fx.extension.handlers.get('session_tree')) await handler({}, ctx);
      else endpoint = 'https://other-provider.invalid';
      return partialResult(options.request);
    });
    ctx = { cwd: fx.root, model, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, baseUrl: endpoint }) },
      sessionManager: { getSessionId: () => `partial-${change}`, getBranch: () => fx.entries } };
    const result = await fx.tool.execute('one', { question: 'Public', scope: 'Fixture' }, new AbortController().signal, undefined, ctx);
    assert.equal(result.details.outputWithheld, true);
    assert.equal(JSON.stringify(result).includes('Keyboard behavior'), false);
    assert.equal(JSON.stringify(result).includes('UNVALIDATED WORKER ANSWER'), false);
    assert.equal(fx.entries.length, change === 'owner' ? 0 : 1);
    if (change === 'destination') assert.equal(fx.entries[0].data.researchStatus, 'incomplete');
  }
});

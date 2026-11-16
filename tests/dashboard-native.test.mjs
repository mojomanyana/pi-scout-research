import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const sdk = process.env.SCOUT_PI_SDK_ROOT;
const enabled = { skip: !sdk && 'Requires an explicitly selected existing Pi SDK' };
const product = fileURLToPath(new URL('../', import.meta.url));
const model = { provider: 'fixture', id: 'subject', api: 'fixture', baseUrl: 'https://provider.invalid' };
async function fixture(t, capabilities = { inventory: 1, refresh: 1 }, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'scout-dashboard-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(product, 'lib'), join(root, 'lib'), { recursive: true });
  await cp(join(product, 'extension'), join(root, 'extension'), { recursive: true });
  const settings = { PI_SCOUT_BRIEFS: join(root, 'briefs'), PI_SCOUT_CATALOG: undefined, PI_SCOUT_WEB_PROFILE: undefined, ...options.settings };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(settings)) value === undefined ? delete process.env[key] : process.env[key] = value;
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const indexKey = `scout-dashboard-index-${randomUUID()}`;
  globalThis[Symbol.for(indexKey)] = options.indexHook;
  t.after(() => { delete globalThis[Symbol.for(indexKey)]; });
  const source = await readFile(join(root, 'extension/index.ts'), 'utf8');
  await writeFile(join(root, 'extension/index.ts'), source.replace('../lib/workspace-briefs.mjs', '../lib/fixture-index.mjs'));
  await writeFile(join(root, 'lib/fixture-index.mjs'), `import { workspaceIdentity, rememberWorkspaceBrief as remember } from './workspace-briefs.mjs';
export { workspaceIdentity }; export const rememberWorkspaceBrief = async (...args) => { await globalThis[Symbol.for(${JSON.stringify(indexKey)})]?.(); return remember(...args); };\n`);
  const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(resolve(sdk, 'dist/core/extensions/loader.js')));
  const { createEventBus } = await import(pathToFileURL(resolve(sdk, 'dist/core/event-bus.js')));
  const bus = createEventBus(), runtime = createExtensionRuntime(), entries = [], publications = [], requests = [];
  runtime.appendEntry = (customType, data) => entries.push({ type: 'custom', customType, data });
  bus.on('pi-daddy:dashboard-source:v1', request => { requests.push(request); request.reply({ ok: true, ...(capabilities ? { capabilities } : {}),
    publish: value => { publications.push(value); return true; }, close() {} }); });
  const paths = [join(root, 'extension/index.ts'), join(root, 'extension/briefs.ts')];
  if (options.workerStatus) {
    const wrapper = join(root, 'extension/fixture-status.ts');
    await writeFile(wrapper, `import { scoutStatus } from './status.ts'; export default pi => scoutStatus(pi, 'worker', { readiness: async () => ({state:'unavailable',label:'Docker unavailable',details:['Synthetic local check']}) });\n`);
    paths.push(wrapper);
  }
  const loaded = await loadExtensions(paths, root, bus, runtime);
  assert.deepEqual(loaded.errors, []);
  let session = 'original', authCalls = 0;
  const ctx = { cwd: root, model, modelRegistry: { getApiKeyAndHeaders: async () => { authCalls++; return { ok: true }; } },
    sessionManager: { getSessionId: () => session, getBranch: () => entries } };
  const event = async name => { for (const extension of loaded.extensions) for (const handler of extension.handlers.get(name) ?? []) await handler({}, ctx); };
  const refresh = () => requests.at(-1).refresh({ signal: new AbortController().signal });
  const brief = { question: 'Accessible form labels', scope: 'Official passages', questions: [], doneWhen: 'Keyboard checked', findings: [], gaps: ['Keyboard passages missing'] };
  const save = () => loaded.extensions[0].tools.get('research_brief').definition.execute('save', brief, new AbortController().signal, undefined, ctx);
  return { root, ctx, entries, publications, requests, loaded, event, refresh, save, authCalls: () => authCalls,
    newSession: () => { session = 'new-session'; entries.length = 0; } };
}

test('native save and /new retain local inventory without provider calls or changing model-facing access', enabled, async t => {
  const fx = await fixture(t); await fx.event('session_start');
  assert.equal((await fx.refresh()).inventory.state, 'unknown');
  assert.equal(fx.authCalls(), 0);
  const result = await fx.save(); assert.equal(result.details.saved, true);
  const reference = result.details.reference, calls = fx.authCalls(), published = fx.publications.length;
  let refreshed = await fx.refresh();
  assert.equal(fx.authCalls(), calls); assert.equal(fx.publications.length, published, 'Refresh returns a snapshot and never publishes itself');
  assert.equal(refreshed.inventory.entries[0].title, 'Accessible form labels');
  assert.match(refreshed.inventory.entries[0].summary, /Partial/);
  assert.equal(refreshed.items.find(item => item.id === 'availability').label, 'No local sources configured');
  fx.newSession(); await fx.event('session_start');
  refreshed = await fx.refresh();
  assert.equal(refreshed.inventory.entries[0].title, 'Accessible form labels'); assert.equal(fx.authCalls(), calls);
  const context = fx.loaded.extensions[0].handlers.get('context')[0];
  assert.equal(await context({ messages: [] }, fx.ctx), undefined, 'Workspace index is never restored into model context');
  const reader = fx.loaded.extensions[1].tools.get('scout_brief_read').definition;
  const denied = await reader.execute('read', { reference }, new AbortController().signal, undefined, fx.ctx);
  assert.equal(denied.details.status, 'denied', 'The terminal grant does not authorize model-facing reads after /new');
});

test('legacy Daddy receives only legacy update fields even when saved inventory exists', enabled, async t => {
  const fx = await fixture(t, null); await fx.event('session_start'); await fx.save();
  for (const value of fx.publications) assert.deepEqual(Object.keys(value).sort(), ['items', 'sequence']);
  assert.deepEqual(Object.keys(await fx.refresh()).sort(), ['items', 'sequence']);
});

test('session/model/shutdown changes and host cancellation revoke old refresh closures', enabled, async t => {
  const fx = await fixture(t); await fx.event('session_start'); await fx.save();
  for (const event of ['model_select', 'session_tree', 'session_switch']) {
    const previous = fx.requests.at(-1); await fx.event(event);
    assert.equal(await previous.refresh({ signal: new AbortController().signal }), undefined);
  }
  const controller = new AbortController(); controller.abort();
  assert.equal(await fx.requests.at(-1).refresh({ signal: controller.signal }), undefined);
  const pending = fx.refresh(); await fx.event('model_select');
  assert.equal(await pending, undefined, 'An in-flight read cannot return an old-owner preview');
  const last = fx.requests.at(-1); await fx.event('session_shutdown');
  assert.equal(await last.refresh({ signal: new AbortController().signal }), undefined);
});

test('replaced workspace withholds the existing source preview', enabled, async t => {
  const fx = await fixture(t); const workspace = join(fx.root, 'workspace'); await mkdir(workspace);
  fx.ctx.cwd = workspace; await fx.event('session_start'); await fx.save();
  await rm(workspace, { recursive: true }); await mkdir(workspace);
  const refreshed = await fx.refresh();
  assert.equal(refreshed.inventory.state, 'unavailable'); assert.deepEqual(refreshed.inventory.entries, []);
});

test('ordinary same-owner activity preserves the last checked inventory and its read timestamp', enabled, async t => {
  const fx = await fixture(t); await fx.event('session_start'); await fx.save();
  const snapshot = await fx.refresh(); await fx.save();
  assert.deepEqual(fx.publications.at(-1).inventory, snapshot.inventory);
  assert.match(snapshot.inventory.summary, /Checked .* UTC/);
});

test('passive local readiness does not read configured source files', enabled, async t => {
  const fx = await fixture(t, { inventory: 1, refresh: 1 }, { settings: { PI_SCOUT_CATALOG: '/fixture-must-not-be-opened/catalog.json' } });
  await fx.event('session_start');
  const snapshot = await fx.refresh();
  assert.equal(snapshot.items.find(item => item.id === 'availability').label, 'Local sources not checked');
  assert.equal(fx.authCalls(), 0);
});

test('a session change during optional local indexing withholds output and further status publication', enabled, async t => {
  let fx;
  fx = await fixture(t, { inventory: 1, refresh: 1 }, { indexHook: async () => {
    fx.newSession(); await fx.event('session_switch'); fx.publications.length = 0;
  } });
  await fx.event('session_start'); const result = await fx.save();
  assert.equal(result.details.outputWithheld, true); assert.equal(result.details.reason, 'owner-changed');
  assert.equal(fx.entries.length, 0); assert.equal(fx.publications.length, 0);
});

const contract = process.env.SCOUT_DASHBOARD_CONTRACT;
test('native snapshots meet the selected Daddy host inventory and legacy field budgets', {
  skip: (!sdk || !contract) && 'Requires an explicitly selected Pi SDK and Daddy dashboard contract',
}, async t => {
  const { validDashboardSourceUpdate } = await import(pathToFileURL(contract));
  const fx = await fixture(t, { inventory: 1, refresh: 1 }, { workerStatus: true });
  await fx.event('session_start'); const saved = await fx.save();
  fx.entries.push({ type: 'custom', customType: 'scout-worker-brief-v2', data: { requestId: 'fixture', reference: saved.details.reference,
    researchStatus: 'incomplete', destination: null } });
  fx.entries.push({ type: 'custom', customType: 'scout-worker-failure-v1', data: { summary: 'Long retained summary '.repeat(30), nextStep: 'Long retained advice\n'.repeat(30) } });
  await fx.event('session_tree');
  const snapshot = await fx.requests.findLast(request => request.producer === 'scout-worker').refresh({ signal: new AbortController().signal });
  assert.equal(validDashboardSourceUpdate(snapshot), true);
  assert.ok(snapshot.items.find(item => item.id === 'last-failure').details.every(value => value.length <= 240));
  assert.ok(fx.publications.every(value => validDashboardSourceUpdate(value)));
});

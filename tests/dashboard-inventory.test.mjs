import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { BriefStore } from '../lib/brief.mjs';
import { workspaceIdentity, readWorkspaceBriefs, rememberWorkspaceBrief, MAX_WORKSPACE_REFS } from '../lib/workspace-briefs.mjs';
import { researchInventory } from '../lib/research-inventory.mjs';
import { probeLocalDocker } from '../lib/worker-setup.mjs';

const destination = { provider: 'fixture', model: 'subject', api: 'fixture', endpoint: 'a'.repeat(64) };
const brief = question => ({ version: 1, question, scope: 'Official forms sources', questions: [], doneWhen: 'Keyboard details checked',
  findings: [{ claim: 'Give every input a visible label.', status: 'supported', reason: 'Exact source passage.', citations: [{ sourceId: 'official-forms' }] }],
  gaps: ['Keyboard details remain unverified.'] });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'scout-dashboard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace'), store = new BriefStore(join(root, 'briefs'));
  await mkdir(cwd);
  const workspace = await workspaceIdentity(cwd), entries = [];
  const ctx = { cwd, modelRegistry: { getApiKeyAndHeaders() { throw Error('Passive display must never resolve provider auth'); } },
    sessionManager: { getSessionId: () => 'session', getBranch: () => entries } };
  const save = async (question = 'Accessible forms', overrides = {}) => {
    const saved = await store.save('original-session', brief(question));
    const item = { kind: 'worker', reference: saved.reference, destination, savedAt: '2026-11-16T10:00:00.000Z', researchStatus: 'incomplete', ...overrides };
    assert.equal(await rememberWorkspaceBrief(store.root, workspace, item), true);
    return item;
  };
  return { root, cwd, store, workspace, ctx, entries, save,
    inventory: options => researchInventory({ root: store.root, ctx, kind: 'worker', ...options }) };
}

test('passive inventory preserves partial findings/gaps across a new session without provider auth or writes', async t => {
  const fx = await fixture(t), item = await fx.save();
  const directory = join(fx.store.root, '.workspaces'), files = await readdir(directory);
  const before = await readFile(join(directory, files[0]), 'utf8');
  assert.equal(before.includes('Give every input'), false, 'Index stores references, not evidence previews');
  const inventory = await fx.inventory();
  assert.equal(inventory.state, 'available'); assert.equal(inventory.count, 1); assert.equal(inventory.limited, true);
  assert.equal(inventory.entries[0].title, 'Accessible forms');
  assert.match(inventory.entries[0].summary, /Partial.*1 sourced findings.*1 sources.*1 gaps/);
  assert.match(inventory.entries[0].details.join(' '), /Give every input.*Keyboard details/);
  assert.equal(inventory.entries[0].reference, JSON.stringify(item.reference));
  assert.equal(await readFile(join(directory, files[0]), 'utf8'), before);
  assert.deepEqual(await readdir(directory), files);
});

test('missing index is unknown and legacy branch records explicitly have limited scope', async t => {
  const fx = await fixture(t);
  assert.equal((await fx.inventory()).state, 'unknown');
  const saved = await fx.store.save('session', brief('Branch-only brief'));
  fx.entries.push({ type: 'custom', customType: 'scout-worker-brief-v2', data: { requestId: 'old', reference: saved.reference, destination } });
  const inventory = await fx.inventory();
  assert.equal(inventory.scope, 'This session only'); assert.equal(inventory.limited, true);
  assert.match(inventory.summary, /Older research may not be listed/);
  assert.match(inventory.entries[0].summary, /Coverage not recorded/);
});

test('reported complete coverage and absent model grants remain distinct from terminal display', async t => {
  const fx = await fixture(t);
  const saved = await fx.store.save('owner', { ...brief('Complete labels research'), gaps: [] });
  assert.equal(await rememberWorkspaceBrief(fx.store.root, fx.workspace, { kind: 'worker', reference: saved.reference,
    destination: null, savedAt: '2026-11-16T11:00:00.000Z', researchStatus: 'complete' }), true);
  const inventory = await fx.inventory();
  assert.match(inventory.entries[0].summary, /Reported complete.*0 gaps/);
  assert.match(inventory.entries[0].details.join(' '), /Saved observations/);
});

test('index is bounded, deduplicated and does not make an all-history count claim', async t => {
  const fx = await fixture(t);
  for (let i = 0; i < MAX_WORKSPACE_REFS + 2; i++) await fx.save(`Question ${i}`);
  const state = await readWorkspaceBriefs(fx.store.root, fx.workspace);
  assert.equal(state.records.length, MAX_WORKSPACE_REFS); assert.equal(state.truncated, true);
  await fx.save(`Question ${MAX_WORKSPACE_REFS + 1}`);
  assert.equal((await readWorkspaceBriefs(fx.store.root, fx.workspace)).records.length, MAX_WORKSPACE_REFS);
  const inventory = await fx.inventory();
  assert.equal(inventory.entries.length, 6); assert.equal(inventory.count, MAX_WORKSPACE_REFS); assert.equal(inventory.limited, true);
  assert.ok(Buffer.byteLength(JSON.stringify(inventory)) <= 8192);
});

test('foreign, replaced and deleted workspaces do not acquire indexed references', async t => {
  const fx = await fixture(t), item = await fx.save();
  const foreign = join(fx.root, 'foreign'); await mkdir(foreign);
  assert.equal((await researchInventory({ root: fx.store.root, ctx: { ...fx.ctx, cwd: foreign }, kind: 'worker' })).state, 'unknown');
  await rename(fx.cwd, `${fx.cwd}-old`); await mkdir(fx.cwd);
  assert.equal((await readWorkspaceBriefs(fx.store.root, fx.workspace)).state, 'unavailable');
  assert.equal((await fx.inventory()).state, 'unavailable');
  assert.equal(await rememberWorkspaceBrief(fx.store.root, fx.workspace, item), false);
  await rm(fx.cwd, { recursive: true }); assert.equal((await fx.inventory()).state, 'unavailable');
});

test('revoked branch or index references and cancelled owner do not disclose preview bodies', async t => {
  const fx = await fixture(t), item = await fx.save();
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal(await fx.inventory({ signal: cancelled.signal }), undefined);
  assert.equal(await fx.inventory({ current: () => false }), undefined);
  const directory = join(fx.store.root, '.workspaces');
  await rm(join(directory, (await readdir(directory))[0]));
  assert.equal((await fx.inventory()).state, 'unknown');
  fx.entries.push({ type: 'custom', customType: 'scout-worker-brief-v2', data: { requestId: 'legacy', reference: item.reference } });
  let reads = 0;
  const during = await fx.inventory({ current: () => { if (++reads > 2) fx.entries.length = 0; return true; } });
  assert.equal(JSON.stringify(during).includes('Give every input'), false);
});

test('damaged, symlinked or locked index fails clearly without damaging the saved brief', async t => {
  const fx = await fixture(t), item = await fx.save();
  const directory = join(fx.store.root, '.workspaces'), file = join(directory, (await readdir(directory))[0]);
  await writeFile(`${file}.lock`, 'writer');
  assert.equal(await rememberWorkspaceBrief(fx.store.root, fx.workspace, item), false);
  assert.equal((await fx.inventory()).entries[0].title, 'Accessible forms');
  await rm(`${file}.lock`); await rm(file); await symlink(join(fx.root, 'outside'), file);
  assert.equal((await fx.inventory()).state, 'unavailable');
  assert.equal(await rememberWorkspaceBrief(fx.store.root, fx.workspace, item), false);
});

function fakeDocker({ endpoint = 'unix:///var/run/docker.sock', code = 0, platform = 'linux', missing = false } = {}) {
  const calls = [];
  return { calls, spawn(executable, args, options) {
    calls.push({ executable, args, env: options.env });
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit('close', null, 'SIGKILL')); };
    queueMicrotask(() => {
      if (missing && executable === 'docker') { child.emit('error', Object.assign(Error(), { code: 'ENOENT' })); child.emit('close', 1); return; }
      const command = args[0] === '--host' ? args[2] : args[0];
      child.stdout.end(command === '--version' ? 'Docker fixture' : command === 'context' ? endpoint : platform);
      child.stderr.end(); child.emit('close', command === 'info' ? code : 0);
    });
    return child;
  } };
}
test('readiness checks only the selected local engine and never setup or research', async () => {
  const fx = fakeDocker();
  const result = await probeLocalDocker({ spawn: fx.spawn, env: { DOCKER_HOST: '', DOCKER_CONTEXT: 'fixture-local' } });
  assert.equal(result.label, 'Local Docker reachable');
  assert.deepEqual(fx.calls.map(call => call.args[0]), ['--version', 'context', '--host']);
  assert.equal(fx.calls.at(-1).env.DOCKER_CONTEXT, undefined);
  assert.match(result.details[0], /model readiness were not tested/);
  for (const endpoint of ['tcp://remote.invalid:2376', 'ssh://remote.invalid', 'unexpected']) {
    const remote = fakeDocker({ endpoint });
    const skipped = await probeLocalDocker({ spawn: remote.spawn, env: { DOCKER_HOST: '', DOCKER_CONTEXT: 'remote' } });
    assert.equal(skipped.state, 'unknown'); assert.equal(remote.calls.some(call => call.args.includes('info')), false);
  }
});
test('readiness respects explicit overrides, WSL fallback, stopped engine and cancellation', async () => {
  const explicit = fakeDocker({ code: 1 });
  const unavailable = await probeLocalDocker({ spawn: explicit.spawn, env: { PI_SCOUT_DOCKER_PATH: 'chosen-client', PI_SCOUT_DOCKER_HOST: 'unix:///chosen.sock' } });
  assert.equal(unavailable.label, 'Docker unavailable');
  assert.ok(explicit.calls.every(call => call.executable === 'chosen-client'));
  assert.equal(explicit.calls.some(call => call.args.includes('context')), false);
  const fallback = fakeDocker({ missing: true });
  const ready = await probeLocalDocker({ spawn: fallback.spawn, desktopPath: 'desktop.exe', env: { WSL_DISTRO_NAME: 'fixture', DOCKER_HOST: '', DOCKER_CONTEXT: '' } });
  assert.equal(ready.state, 'observed'); assert.equal(fallback.calls.at(-1).args[1], 'npipe:////./pipe/dockerDesktopLinuxEngine');
  const controller = new AbortController(); controller.abort();
  const none = fakeDocker(); assert.equal(await probeLocalDocker({ spawn: none.spawn, signal: controller.signal }), undefined); assert.equal(none.calls.length, 0);
});

test('a stalled readiness client is bounded and cannot claim successful readiness', async () => {
  let stopped = false;
  const result = await probeLocalDocker({ env: { PI_SCOUT_DOCKER_PATH: 'stalled' }, spawn() {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { stopped = true; queueMicrotask(() => child.emit('close', null, 'SIGKILL')); };
    return child;
  } });
  assert.equal(stopped, true); assert.equal(result.state, 'unknown'); assert.equal(result.label, 'Docker check incomplete');
});

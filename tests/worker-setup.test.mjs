import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, chmod, rm, appendFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkerSetup } from '../lib/worker-setup.mjs';

const moduleUrl = new URL('../lib/worker-setup.mjs', import.meta.url);
const product = fileURLToPath(new URL('../', import.meta.url));
const posix = { skip: process.platform === 'win32' && 'Fake Docker executables use POSIX shebangs; run in WSL/Linux.' };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'scout-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'package'), cacheRoot = join(root, 'cache'), bin = join(root, 'bin');
  await mkdir(bin); await mkdir(packageRoot);
  for (const path of ['Dockerfile', '.dockerignore', 'lib', 'research', 'worker']) {
    await cp(join(product, path), join(packageRoot, path), { recursive: true });
  }
  const state = join(root, 'state.json'), log = join(root, 'calls.jsonl');
  await writeFile(state, '{}');
  const fake = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const client = path.basename(process.argv[1]);
fs.appendFileSync(process.env.SCOUT_TEST_LOG, JSON.stringify({ client, args, pid: process.pid }) + '\\n');
const prefix = args[0] === '--host' ? 2 : 0;
const command = args[prefix];
if (command === '--version') {
  if (client === 'docker' && process.env.SCOUT_TEST_STUB) {
    console.error("The command 'docker' could not be found in this WSL 2 distro."); process.exit(1);
  }
  console.log('Docker version test'); process.exit(0);
}
if (command === 'info') {
  if (process.env.SCOUT_TEST_STOPPED === client) process.exit(1);
  console.log('linux'); process.exit(0);
}
if (command === 'image') {
  const images = JSON.parse(fs.readFileSync(process.env.SCOUT_TEST_STATE, 'utf8'));
  const selected = images[args.at(-1)] || Object.values(images).find(image => image.Id === args.at(-1));
  if (!selected) { console.error('Error: No such image'); process.exit(1); }
  console.log(JSON.stringify([selected])); process.exit(0);
}
if (command === 'build') {
  if (process.env.SCOUT_TEST_FAIL) { console.error('private diagnostic must not escape'); process.exit(5); }
  if (process.env.SCOUT_TEST_FLOOD) { process.stdout.write('x'.repeat(2 * 1024 * 1024)); setTimeout(() => {}, 10000); }
  else setTimeout(() => {
    const tag = args[args.indexOf('--tag') + 1];
    const label = args[args.indexOf('--label') + 1];
    const hash = label.slice(label.indexOf('=') + 1);
    const images = JSON.parse(fs.readFileSync(process.env.SCOUT_TEST_STATE, 'utf8'));
    images[tag] = { Id: 'sha256:' + hash, Config: { Labels: { 'pi-scout.worker-source': hash } } };
    fs.writeFileSync(process.env.SCOUT_TEST_STATE, JSON.stringify(images));
  }, Number(process.env.SCOUT_TEST_BUILD_DELAY || 0));
} else process.exit(9);
`;
  for (const name of ['docker', 'docker.exe']) {
    await writeFile(join(bin, name), fake); await chmod(join(bin, name), 0o700);
  }
  await writeFile(join(bin, 'wslpath'), `#!${process.execPath}
console.log('C:\\\\package');
`);
  await chmod(join(bin, 'wslpath'), 0o700);
  const env = { PI_SCOUT_DOCKER_PATH: join(bin, 'docker'), PATH: bin,
    SCOUT_TEST_STATE: state, SCOUT_TEST_LOG: log, WSL_DISTRO_NAME: 'Test' };
  const prepare = createWorkerSetup({ desktopPath: join(bin, 'docker.exe') });
  return { root, packageRoot, cacheRoot, state, log, bin, env, prepare,
    run: changes => prepare({ packageRoot, cacheRoot, env, ...changes }),
    calls: async () => {
      try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
      catch (failure) { if (failure.code === 'ENOENT') return []; throw failure; }
    } };
}

function processRun(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr, pid: child.pid }));
  });
}

test('cold build uses exact source identity; warm sessions reuse it and changed inputs rebuild', posix, async t => {
  const fx = await fixture(t), stages = [];
  const cold = await fx.run({ onProgress: event => stages.push(event.stage) });
  assert.equal(cold.mode, 'public'); assert.match(cold.image, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(stages, ['checking', 'building', 'ready']);
  assert.deepEqual(await fx.run(), cold);
  assert.equal((await fx.calls()).filter(call => call.args.includes('build')).length, 1);
  await appendFile(join(fx.packageRoot, 'research', 'SKILL.md'), '\nNew packaged instruction.\n');
  const changed = await fx.run();
  assert.notEqual(changed.image, cold.image);
  assert.equal((await fx.calls()).filter(call => call.args.includes('build')).length, 2);
  assert.deepEqual(await readdir(fx.cacheRoot), []);
});

test('separate Pi processes share one cold build and receive the same immutable image', posix, async t => {
  const fx = await fixture(t);
  const runner = join(fx.root, 'runner.mjs');
  await writeFile(runner, `import { prepareWorker } from ${JSON.stringify(moduleUrl.href)};
console.log(JSON.stringify(await prepareWorker({ packageRoot: process.argv[2], cacheRoot: process.argv[3] })));
`);
  const env = { ...fx.env, SCOUT_TEST_BUILD_DELAY: '400' };
  const runs = await Promise.all(Array.from({ length: 3 }, () => processRun(runner, [fx.packageRoot, fx.cacheRoot], env)));
  for (const run of runs) assert.equal(run.code, 0, run.stderr);
  assert.equal(new Set(runs.map(run => JSON.parse(run.stdout).image)).size, 1);
  assert.equal((await fx.calls()).filter(call => call.args.includes('build')).length, 1);
  assert.deepEqual(await readdir(fx.cacheRoot), []);
});

test('explicit image and offline mode are respected; invalid or missing override never builds', posix, async t => {
  const fx = await fixture(t), selected = `sha256:${'d'.repeat(64)}`;
  await writeFile(fx.state, JSON.stringify({ selected: { Id: selected, Config: {} } }));
  const value = await fx.run({ env: { ...fx.env, PI_SCOUT_WORKER_IMAGE: selected, PI_SCOUT_WORKER_MODE: 'offline', PI_SCOUT_DOCKER_HOST: 'unix:///selected.sock' } });
  assert.equal(value.image, selected); assert.equal(value.mode, 'offline');
  assert.deepEqual(value.dockerArgs, ['--host', 'unix:///selected.sock']);
  await assert.rejects(fx.run({ env: { ...fx.env, PI_SCOUT_WORKER_IMAGE: 'mutable:latest' } }), { code: 'SETUP_IMAGE' });
  await assert.rejects(fx.run({ env: { ...fx.env, PI_SCOUT_WORKER_IMAGE: `sha256:${'e'.repeat(64)}` } }), { code: 'SETUP_IMAGE_MISSING' });
  assert.equal((await fx.calls()).filter(call => call.args.includes('build')).length, 0);
});

test('only a missing default CLI or WSL stub selects the Desktop fallback; stopped and explicit clients stay selected', posix, async t => {
  const fx = await fixture(t);
  const defaultEnv = { ...fx.env }; delete defaultEnv.PI_SCOUT_DOCKER_PATH;
  const stub = await fx.run({ env: { ...defaultEnv, SCOUT_TEST_STUB: '1' } });
  assert.equal(stub.dockerPath, join(fx.bin, 'docker.exe'));
  assert.deepEqual(stub.dockerArgs, ['--host', 'npipe:////./pipe/dockerDesktopLinuxEngine']);
  const before = (await fx.calls()).length;
  await assert.rejects(fx.run({ env: { ...defaultEnv, SCOUT_TEST_STOPPED: 'docker' } }), { code: 'DOCKER_UNAVAILABLE' });
  assert.ok((await fx.calls()).slice(before).every(call => call.client === 'docker'));
  await assert.rejects(fx.run({ env: { ...fx.env, PI_SCOUT_DOCKER_PATH: join(fx.root, 'absent') } }), { code: 'DOCKER_MISSING' });
  await rm(join(fx.bin, 'docker'));
  const missing = await fx.run({ env: { ...defaultEnv, PI_SCOUT_DOCKER_HOST: 'tcp://selected:2375' } });
  assert.equal(missing.dockerPath, join(fx.bin, 'docker.exe'));
  assert.deepEqual(missing.dockerArgs, ['--host', 'tcp://selected:2375']);
  for (const selected of [{ DOCKER_HOST: 'tcp://standard:2375' }, { DOCKER_CONTEXT: 'my-engine' }]) {
    const standard = await fx.run({ env: { ...defaultEnv, ...selected } });
    assert.deepEqual(standard.dockerArgs, [], 'Standard Docker selection must not be redirected to the Desktop pipe');
  }
});

test('build failure releases its lock and gives a sanitized retryable error', posix, async t => {
  const fx = await fixture(t);
  await assert.rejects(fx.run({ env: { ...fx.env, SCOUT_TEST_FAIL: '1' } }), failure => {
    assert.equal(failure.code, 'SETUP_BUILD'); assert.doesNotMatch(failure.message, /private diagnostic/); return true;
  });
  assert.deepEqual(await readdir(fx.cacheRoot), []);
  assert.match((await fx.run()).image, /^sha256:/);
});

test('cancellation stops the owned build before releasing the lock; captured output is bounded', posix, async t => {
  const fx = await fixture(t), controller = new AbortController();
  let builtPid;
  const work = fx.run({ signal: controller.signal, env: { ...fx.env, SCOUT_TEST_BUILD_DELAY: '30000' } });
  for (let n = 0; n < 200; n++) {
    builtPid = (await fx.calls()).find(call => call.args.includes('build'))?.pid;
    if (builtPid) break;
    await delay(10);
  }
  assert.ok(builtPid, 'Build must have started before cancellation');
  controller.abort();
  await assert.rejects(work, { code: 'SETUP_CANCELLED' });
  assert.throws(() => process.kill(builtPid, 0), { code: 'ESRCH' });
  assert.deepEqual(await readdir(fx.cacheRoot), []);
  await assert.rejects(fx.run({ env: { ...fx.env, SCOUT_TEST_FLOOD: '1' } }), { code: 'SETUP_OUTPUT_LIMIT' });
  assert.deepEqual(await readdir(fx.cacheRoot), []);
});

test('a live setup owner is never reclaimed; waits cancel and dead owners can be recovered', posix, async t => {
  const fx = await fixture(t);
  await fx.run();
  const images = JSON.parse(await readFile(fx.state, 'utf8'));
  const hash = Object.values(images)[0].Config.Labels['pi-scout.worker-source'];
  await writeFile(fx.state, '{}');
  const lock = join(fx.cacheRoot, `${hash}.lock`);
  await mkdir(lock); await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'live', state: 'idle' }));
  const controller = new AbortController();
  const waiting = fx.run({ signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(waiting, { code: 'SETUP_CANCELLED' });
  assert.equal(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')).token, 'live');
  const deadScript = join(fx.root, 'done.mjs'); await writeFile(deadScript, '');
  const completed = await processRun(deadScript, [], fx.env);
  assert.equal(completed.code, 0);
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: completed.pid, token: 'dead', state: 'idle' }));
  const recovered = await Promise.all([fx.run(), fx.run(), fx.run()]);
  assert.equal(new Set(recovered.map(value => value.image)).size, 1);
  assert.deepEqual(await readdir(fx.cacheRoot), []);
});

test('unconfirmed process settlement keeps the setup lock instead of permitting a duplicate build', posix, async t => {
  const fx = await fixture(t), controller = new AbortController();
  const prepare = createWorkerSetup({
    spawn(executable, args, options) {
      if (!args.includes('build')) return spawn(executable, args, options);
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => false;
      setTimeout(() => controller.abort(), 20);
      return child;
    },
  });
  await assert.rejects(prepare({ packageRoot: fx.packageRoot, cacheRoot: fx.cacheRoot, env: fx.env, signal: controller.signal }),
    { code: 'SETUP_UNSETTLED' });
  const locks = await readdir(fx.cacheRoot);
  assert.equal(locks.length, 1);
  assert.equal(JSON.parse(await readFile(join(fx.cacheRoot, locks[0], 'owner.json'), 'utf8')).pid, process.pid);
});

test('parent crash does not authorize a second build while its detached client remains alive', posix, async t => {
  const fx = await fixture(t);
  const runner = join(fx.root, 'crash-runner.mjs');
  await writeFile(runner, `import { prepareWorker } from ${JSON.stringify(moduleUrl.href)};
await prepareWorker({ packageRoot: process.argv[2], cacheRoot: process.argv[3] });
`);
  const parent = spawn(process.execPath, [runner, fx.packageRoot, fx.cacheRoot], {
    env: { ...process.env, ...fx.env, SCOUT_TEST_BUILD_DELAY: '1200' }, stdio: 'ignore',
  });
  const exited = new Promise(resolve => parent.once('close', resolve));
  t.after(() => { try { parent.kill('SIGKILL'); } catch {} });
  let client, owner;
  for (let n = 0; n < 300; n++) {
    client = (await fx.calls()).find(call => call.args.includes('build'));
    const locks = await readdir(fx.cacheRoot).catch(() => []);
    if (locks[0]) owner = JSON.parse(await readFile(join(fx.cacheRoot, locks[0], 'owner.json'), 'utf8'));
    if (client && owner?.state === 'running') break;
    await delay(10);
  }
  assert.ok(client); assert.equal(owner.childPid, client.pid);
  parent.kill('SIGKILL'); await exited;
  assert.doesNotThrow(() => process.kill(client.pid, 0));
  const controller = new AbortController();
  const waiting = fx.run({ signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(waiting, { code: 'SETUP_CANCELLED' });
  assert.equal((await fx.calls()).filter(call => call.args.includes('build')).length, 1);
  await delay(1300); // Let this test's orphaned fake build finish before removing its fixture.
});

test('unknown crashed spawn and incomplete lock fail clearly without replacing uncertain ownership', posix, async t => {
  const fx = await fixture(t);
  await fx.run();
  const images = JSON.parse(await readFile(fx.state, 'utf8'));
  const hash = Object.values(images)[0].Config.Labels['pi-scout.worker-source'];
  await writeFile(fx.state, '{}');
  const done = join(fx.root, 'done.mjs'); await writeFile(done, '');
  const deadParent = (await processRun(done, [], fx.env)).pid;
  const lock = join(fx.cacheRoot, `${hash}.lock`); await mkdir(lock);
  const ownerFile = join(lock, 'owner.json');
  for (const state of [{ state: 'starting' }, { state: 'running', childPid: deadParent, recoverable: false }]) {
    await writeFile(ownerFile, JSON.stringify({ pid: deadParent, token: 'uncertain', ...state }));
    await assert.rejects(fx.run(), { code: 'SETUP_LOCK_UNCERTAIN' });
    assert.equal(JSON.parse(await readFile(ownerFile, 'utf8')).token, 'uncertain');
  }
  await rm(ownerFile);
  await assert.rejects(fx.run(), { code: 'SETUP_LOCK_UNCERTAIN' });
  assert.deepEqual(await readdir(lock), []);
  assert.equal((await fx.calls()).filter(call => call.args.includes('build')).length, 1);
});

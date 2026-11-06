import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('optional prewarm CLI delegates setup, reports readiness, and never hides errors', async t => {
  const root = await mkdtemp(join(tmpdir(), 'scout-prewarm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts')); await mkdir(join(root, 'lib'));
  const script = join(root, 'scripts/build-worker.mjs');
  await copyFile(new URL('../scripts/build-worker.mjs', import.meta.url), script);
  await writeFile(join(root, 'lib/worker-setup.mjs'), `export async function prepareWorker({onProgress}) {
    if (process.env.SCOUT_TEST_FAIL) throw Error('Docker is not running.');
    onProgress({stage:'ready'}); return {image:'sha256:${'a'.repeat(64)}',mode:'public'};
  }`);
  const run = (args = [], env = {}) => spawnSync(process.execPath, [script, ...args], {
    cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, ...env },
  });
  const help = run(['--help'], { SCOUT_TEST_FAIL: '1' });
  assert.equal(help.status, 0); assert.match(help.stdout, /automatically/);
  assert.equal(run(['--unexpected']).status, 2);
  const success = run(); assert.equal(success.status, 0);
  assert.match(success.stdout, /No environment exports are needed/);
  const failure = run([], { SCOUT_TEST_FAIL: '1' });
  assert.equal(failure.status, 1); assert.match(failure.stderr, /Docker is not running/);
  assert.doesNotMatch(failure.stdout, /ready/);
});

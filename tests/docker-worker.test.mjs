import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createDockerRunner } from '../lib/docker-worker.mjs';
import { MAX_FRAME_BYTES } from '../lib/worker-protocol.mjs';

const IMAGE = 'sha256:' + 'a'.repeat(64), ID = 'b'.repeat(64);
const model = { provider: 'fixture', id: 'model', name: 'Fixture', reasoning: false, input: ['text'],
  contextWindow: 4096, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const request = { type: 'start', version: 1, mode: 'offline', requestId: 'fixture-request', question: 'What evidence is available?', scope: 'Supplied sources only', sources: [], model };
const complete = () => ({ type: 'result', version: 1, requestId: request.requestId, status: 'complete', answer: 'No source was supplied.',
  sources: [], brief: { question: request.question, scope: request.scope, questions: [], doneWhen: 'Identify evidence gaps', findings: [], gaps: ['No source supplied'] } });

function fakeDocker(options = {}) {
  const state = { calls: [], frames: [], exists: false, started: false, closed: false, killed: false, modelResponses: [] };
  const image = { Id: IMAGE, Os: 'linux', Config: { User: '1000:1000', WorkingDir: '/workspace',
    Entrypoint: ['node', '/opt/scout/worker/index.mjs'], Cmd: [], Env: ['PATH=/usr/local/bin:/usr/bin'], Volumes: null } };
  let owner, name, mode;
  const inspect = () => ({ Id: ID, Image: IMAGE, Config: { ...image.Config, OpenStdin: true,
    Labels: { 'pi-scout.worker-owner': owner } }, Mounts: [],
    HostConfig: { NetworkMode: mode, LogConfig: { Type: 'none' }, Init: true, ReadonlyRootfs: true, Privileged: false, Binds: null, VolumesFrom: null,
      CapDrop: ['ALL'], CapAdd: null, Devices: [], DeviceRequests: [], SecurityOpt: ['no-new-privileges'],
      Memory: 1073741824, MemorySwap: 1073741824, NanoCpus: 2000000000, PidsLimit: 128,
      Tmpfs: { '/workspace': 'rw,nosuid,nodev,size=128m,uid=1000,gid=1000,mode=700', '/tmp': 'rw,nosuid,nodev,size=128m,mode=1777' } },
    State: { Running: state.started && !state.closed, ExitCode: state.closed ? (options.workerExit ?? 0) : 0, OOMKilled: false },
  });
  const spawn = (path, args, launch) => {
    state.calls.push({ path, args, launch });
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let closed = false;
    function close(code = 0) {
      if (closed) return;
      closed = true;
      if (args[0] === 'start') state.closed = true;
      child.stdout.end(); child.stderr.end(); child.emit('close', code, null);
    }
    function emit(frame) { if (!closed) child.stdout.write(JSON.stringify(frame) + '\n'); }
    function finish(frame = complete()) { emit(frame); queueMicrotask(() => close(options.workerExit ?? 0)); }
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      try {
        const frame = JSON.parse(chunk.toString()); state.frames.push(frame);
        if (frame.type === 'start') {
          if (options.onStart) options.onStart({ emit, finish, child, close, state });
          else emit({ type: 'model_request', id: 'm1', context: { systemPrompt: 'Synthetic', messages: [], tools: [] } });
        } else if (frame.type === 'model_response') { state.modelResponses.push(frame); setImmediate(() => finish()); }
        else if (frame.type === 'model_error') { setImmediate(() => { emit({ type: 'error', message: frame.message }); queueMicrotask(() => close(1)); }); }
        callback();
      } catch (error) { callback(error); }
    } });
    child.kill = () => { state.killed = true; queueMicrotask(() => close(137)); return true; };
    queueMicrotask(() => {
      child.emit('spawn');
      if (args[0] === 'image') { child.stdout.write(JSON.stringify([options.image ?? image])); close(); }
      else if (args[0] === 'create') {
        state.exists = true; owner = args[args.indexOf('--label') + 1].split('=')[1];
        name = args[args.indexOf('--name') + 1]; mode = args[args.indexOf('--network') + 1];
        child.stdout.write(ID + '\n'); close(options.createFail ? 1 : 0);
      } else if (args[0] === 'inspect') {
        if (!state.exists) close(1);
        else { const value = inspect(); options.mutateInspect?.(value); child.stdout.write(JSON.stringify([value])); close(); }
      } else if (args[0] === 'start') { state.started = true; }
      else if (args[0] === 'rm') { assert.equal(args.at(-1), ID); if (!options.removeFail) state.exists = false; close(options.removeFail ? 1 : 0); }
      else if (args[0] === 'ps') { if (state.exists) child.stdout.write(ID + '\n'); close(); }
      else throw Error('Unexpected Docker command: ' + args[0]);
    });
    return child;
  };
  return { state, run: createDockerRunner({ spawn }) };
}

function runOptions(overrides = {}) {
  return { request, image: IMAGE, onModelRequest: async () => ({ role: 'assistant', content: [{ type: 'text', text: 'Synthetic result' }] }),
    limits: { commandMs: 300, wallMs: 2000, drainMs: 50 }, ...overrides };
}

test('broker transports one native answer and only releases completion after owned cleanup', async () => {
  const fake = fakeDocker(); let calls = 0;
  const answer = await fake.run(runOptions({ onModelRequest: async (context, signal) => {
    calls++; assert.equal(context.systemPrompt, 'Synthetic'); assert.equal(signal.aborted, false);
    return { role: 'assistant', content: [{ type: 'text', text: 'Public draft' }] };
  } }));
  assert.equal(calls, 1); assert.equal(answer.result.answer, complete().answer);
  assert.equal(answer.runtime.cleanup.confirmed, true); assert.equal(fake.state.exists, false);
  assert.equal(answer.runtime.modelCallbackSettled, true); assert.equal(answer.runtime.semanticApproval, false);
  assert.equal(fake.state.modelResponses[0].message.role, 'assistant');
  assert.ok(fake.state.calls.every(call => call.launch.shell === false && call.launch.windowsHide));
  const create = fake.state.calls.find(call => call.args[0] === 'create').args;
  assert.ok(create.includes('--pull=never')); assert.ok(create.includes('--memory-swap'));
  assert.equal(create[create.indexOf('--network') + 1], 'none');
  assert.deepEqual(create.filter(arg => arg.startsWith('HOME=')), ['HOME=/workspace']);
  assert.ok(answer.runtime.commands.every(command => command.drained));
});

test('request mode selects bridge without a separate override and mismatching overrides are refused', async () => {
  const fake = fakeDocker(); const answer = await fake.run(runOptions({ request: { ...request, mode: 'public' } }));
  assert.equal(fake.state.frames[0].mode, 'public'); assert.equal(answer.runtime.onlineQualified, false);
  const create = fake.state.calls.find(call => call.args[0] === 'create').args;
  assert.equal(create[create.indexOf('--network') + 1], 'bridge');
  const before = fake.state.calls.length;
  await assert.rejects(fake.run(runOptions({ mode: 'public' })), /mode must match/);
  await assert.rejects(fake.run(runOptions({ request: { ...request, version: 99 } })), /Unsupported/);
  assert.equal(fake.state.calls.length, before);
});

test('mutable images and an unexpected applied container profile stop before worker execution', async () => {
  const fake = fakeDocker({ mutateInspect: value => { value.HostConfig.NetworkMode = 'host'; } });
  await assert.rejects(fake.run(runOptions({ image: 'worker:latest' })), /immutable/);
  assert.equal(fake.state.calls.length, 0);
  await assert.rejects(fake.run(runOptions()), error => error.code === 'CONTAINER_PROFILE' && error.runtime.cleanup.confirmed);
  assert.equal(fake.state.started, false); assert.equal(fake.state.exists, false);
});

test('ambiguous create failure still discovers and removes the uniquely owned container', async () => {
  const fake = fakeDocker({ createFail: true });
  await assert.rejects(fake.run(runOptions()), error => error.code === 'DOCKER_COMMAND' && error.runtime.cleanup.confirmed);
  assert.equal(fake.state.started, false); assert.equal(fake.state.exists, false);
  assert.ok(fake.state.calls.some(call => call.args[0] === 'ps'));
});

test('malformed output and provider-option injection are rejected before model work', async () => {
  for (const onStart of [
    ({ child }) => child.stdout.write('not-json\n'),
    ({ emit }) => emit({ type: 'model_request', id: 'bad', context: { messages: [], baseUrl: 'https://attacker.invalid' } }),
    ({ finish }) => finish({ ...complete(), requestId: 'different-request' }),
  ]) {
    let calls = 0; const fake = fakeDocker({ onStart });
    await assert.rejects(fake.run(runOptions({ onModelRequest: async () => { calls++; } })), error => error.runtime.cleanup.confirmed);
    assert.equal(calls, 0); assert.equal(fake.state.exists, false);
  }
});

test('concurrent model requests are rejected and the original callback receives cancellation', async () => {
  let aborted = false;
  const fake = fakeDocker({ onStart: ({ emit }) => {
    emit({ type: 'model_request', id: 'a', context: { messages: [] } });
    setImmediate(() => emit({ type: 'model_request', id: 'b', context: { messages: [] } }));
  } });
  await assert.rejects(fake.run(runOptions({ onModelRequest: (_context, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  }) })), error => error.code === 'PROTOCOL' && error.runtime.cleanup.confirmed);
  assert.equal(aborted, true); assert.equal(fake.state.exists, false);
});

test('operator cancellation and process timeout both clean up a blocked worker', async () => {
  for (const timeout of [false, true]) {
    const control = new AbortController(); const fake = fakeDocker();
    await assert.rejects(fake.run(runOptions({ signal: control.signal, limits: { commandMs: 300, wallMs: timeout ? 40 : 2000, drainMs: 50 },
      onModelRequest: (_context, signal) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        if (!timeout) queueMicrotask(() => control.abort());
      }),
    })), error => error.code === (timeout ? 'TIMEOUT' : 'CANCELLED') && error.runtime.cleanup.confirmed);
    assert.equal(fake.state.exists, false); assert.equal(fake.state.killed, true);
  }
});

test('oversized output kills the worker and incomplete cleanup never returns a result', async () => {
  const oversized = fakeDocker({ onStart: ({ child }) => child.stdout.write('x'.repeat(MAX_FRAME_BYTES + 1)) });
  await assert.rejects(oversized.run(runOptions()), error => error.code === 'FRAME_LIMIT' && error.runtime.cleanup.confirmed);
  const retained = fakeDocker({ removeFail: true });
  await assert.rejects(retained.run(runOptions()), error => error.code === 'CLEANUP_FAILED' && !error.runtime.cleanup.confirmed);
  assert.equal(retained.state.exists, true);
});

test('model failures are redacted and progress excludes worker free text', async () => {
  const progress = [];
  const fake = fakeDocker({ onStart: ({ emit }) => {
    emit({ type: 'progress', stage: 'researching', message: 'private reasoning should not leave the worker' });
    emit({ type: 'model_request', id: 'm1', context: { messages: [] } });
  } });
  await assert.rejects(fake.run(runOptions({ onProgress: value => progress.push(value),
    onModelRequest: async () => { throw Error('Authorization: secret-provider-token'); },
  })), error => error.code === 'WORKER_ERROR' && !JSON.stringify(error.runtime).includes('secret-provider-token'));
  assert.deepEqual(progress, [{ stage: 'researching' }]);
  assert.equal(fake.state.frames.at(-1).message, 'Host model request failed');
});

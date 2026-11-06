import { spawn as nativeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { validateRequest, validateResult, encodeFrame, parseFrame, MAX_FRAME_BYTES } from './worker-protocol.mjs';

const OWNER_LABEL = 'pi-scout.worker-owner';
const OUTPUT_LIMIT = 16 * 1024 * 1024;
const COMMAND_LIMIT = 2 * 1024 * 1024;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const CONTAINER = /^[a-f0-9]{64}$/;
const ENTRYPOINT = ['node', '/opt/scout/worker/index.mjs'];

export class ScoutWorkerError extends Error {
  constructor(code, message, runtime, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ScoutWorkerError';
    this.code = code;
    this.runtime = runtime;
  }
}

function positive(value, fallback, name) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) throw new TypeError(`${name} must be a positive integer`);
  return selected;
}

function cliOptions(values) {
  if (!Array.isArray(values)) throw new TypeError('dockerArgs must be an array');
  for (let n = 0; n < values.length; n += 2) {
    if (!['--host', '-H', '--context'].includes(values[n]) || typeof values[n + 1] !== 'string' ||
        !values[n + 1] || /[\r\n\0]/.test(values[n + 1]) || /:\/\/[^/]*:[^/@]*@/.test(values[n + 1])) {
      throw new TypeError('Only operator-selected Docker host/context options without embedded passwords are supported');
    }
  }
  return [...values];
}

function fail(code, message) { return new ScoutWorkerError(code, message); }

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? fail('CANCELLED', 'Research cancelled'));
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

function imageContract(image, expected) {
  if (!image || image.Id !== expected || image.Os !== 'linux' ||
      image.Config?.User !== '1000:1000' || image.Config.WorkingDir !== '/workspace' ||
      JSON.stringify(image.Config.Entrypoint) !== JSON.stringify(ENTRYPOINT) ||
      (image.Config.Cmd?.length ?? 0) !== 0 || Object.keys(image.Config.Volumes ?? {}).length ||
      image.Config.Healthcheck || (image.Config.OnBuild?.length ?? 0)) {
    throw fail('IMAGE_PROFILE', 'Image does not match the Scout worker image contract');
  }
  // The operator must build/select the worker image. Never inherit embedded auth.
  const safeEnv = new Set(['PATH', 'NODE_VERSION', 'YARN_VERSION', 'HOME', 'NODE_ENV']);
  if ((image.Config.Env ?? []).some(value => !safeEnv.has(value.split('=', 1)[0]))) {
    throw fail('IMAGE_PROFILE', 'Worker image has an unexpected environment variable');
  }
}

function owned(inspect, owner) {
  return inspect && CONTAINER.test(inspect.Id) && inspect.Config?.Labels?.[OWNER_LABEL] === owner;
}

function modelContext(context) {
  return context && typeof context === 'object' && !Array.isArray(context) &&
    Object.keys(context).every(key => ['systemPrompt', 'messages', 'tools'].includes(key)) &&
    Array.isArray(context.messages) && (context.systemPrompt === undefined || typeof context.systemPrompt === 'string') &&
    (context.tools === undefined || Array.isArray(context.tools));
}

function containerContract(inspect, image, mode, owner) {
  const h = inspect?.HostConfig;
  if (!owned(inspect, owner) || inspect.Image !== image || inspect.Config.User !== '1000:1000' ||
      inspect.Config.WorkingDir !== '/workspace' || JSON.stringify(inspect.Config.Entrypoint) !== JSON.stringify(ENTRYPOINT) ||
      (inspect.Config.Cmd?.length ?? 0) !== 0 || !inspect.Config.OpenStdin || !h ||
      h.NetworkMode !== (mode === 'offline' ? 'none' : 'bridge') || h.LogConfig?.Type !== 'none' || !h.Init || !h.ReadonlyRootfs || h.Privileged ||
      (h.Binds?.length ?? 0) || (inspect.Mounts?.length ?? 0) || (h.VolumesFrom?.length ?? 0) ||
      (h.Devices?.length ?? 0) || (h.DeviceRequests?.length ?? 0) || (h.CapAdd?.length ?? 0) ||
      JSON.stringify(h.CapDrop) !== JSON.stringify(['ALL']) ||
      !h.SecurityOpt?.some(option => ['no-new-privileges', 'no-new-privileges:true'].includes(option)) ||
      h.SecurityOpt.some(option => !['no-new-privileges', 'no-new-privileges:true'].includes(option)) ||
      h.Memory !== 1073741824 || h.MemorySwap !== 1073741824 || h.NanoCpus !== 2000000000 || h.PidsLimit !== 128 ||
      h.Tmpfs?.['/workspace'] !== 'rw,nosuid,nodev,size=128m,uid=1000,gid=1000,mode=700' ||
      h.Tmpfs?.['/tmp'] !== 'rw,nosuid,nodev,size=128m,mode=1777' || Object.keys(h.Tmpfs).length !== 2) {
    throw fail('CONTAINER_PROFILE', 'Docker did not apply the required Scout worker profile');
  }
}

/** Host-only dependency injection permits lifecycle tests without Docker or models. */
export function createDockerRunner({ spawn = nativeSpawn } = {}) {
  return async function runScout({ request, image, mode: requestedMode, signal, onModelRequest,
    onProgress, dockerPath = 'docker', dockerArgs = [], limits = {} }) {
    if (!IMAGE.test(image ?? '')) throw new TypeError('image must be an operator-selected immutable sha256 image ID');
    const start = validateRequest(request);
    const mode = requestedMode ?? start.mode;
    if (mode !== start.mode) throw new TypeError('mode must match the validated worker request');
    if (typeof onModelRequest !== 'function') throw new TypeError('onModelRequest is required');
    if (typeof dockerPath !== 'string' || !dockerPath || /[\r\n\0]/.test(dockerPath)) throw new TypeError('Invalid Docker executable');
    const prefix = cliOptions(dockerArgs);
    const wallMs = positive(limits.wallMs, 1200000, 'wallMs');
    const commandMs = positive(limits.commandMs, 15000, 'commandMs');
    const drainMs = positive(limits.drainMs, 3000, 'drainMs');
    const owner = randomUUID();
    const name = `scout-worker-${owner}`;
    const runtime = { image, mode, container: name, commands: [], cleanup: { confirmed: false },
      onlineQualified: false, semanticApproval: false };
    const controller = new AbortController();
    const cancelled = () => controller.abort(fail('CANCELLED', 'Research cancelled'));
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) cancelled();
    const wall = setTimeout(() => controller.abort(fail('TIMEOUT', 'Research process time limit reached')), wallMs);
    let createAttempted = false, id, result, failure;

    // Every Docker client is bounded and its close event includes pipe drainage.
    function client(args, { commandSignal, timeout = commandMs, stream } = {}) {
      return new Promise((resolve, reject) => {
        const record = { argv: [dockerPath, ...prefix, ...args], startedAt: new Date().toISOString(),
          stdoutBytes: 0, stderrBytes: 0, drained: false };
        runtime.commands.push(record);
        let child, timer, drainTimer, error, output = '', stderr = '', done = false;
        function finish(code, killedSignal, drained) {
          if (done) return;
          done = true; clearTimeout(timer); clearTimeout(drainTimer);
          commandSignal?.removeEventListener('abort', aborted);
          record.exitCode = code; record.signal = killedSignal; record.drained = drained;
          record.finishedAt = new Date().toISOString();
          if (!drained) { child?.stdout?.destroy(); child?.stderr?.destroy(); child?.stdin?.destroy(); }
          if (error) reject(error);
          else resolve({ code, stdout: output, stderr, drained });
        }
        function stop(reason) {
          if (done || error) return;
          error = reason;
          drainTimer = setTimeout(() => finish(null, null, false), drainMs);
          try { child?.kill('SIGKILL'); } catch { /* Cleanup uses the owned container ID. */ }
        }
        function aborted() { stop(commandSignal.reason ?? fail('CANCELLED', 'Research cancelled')); }
        if (commandSignal?.aborted) { error = commandSignal.reason; finish(null, null, true); return; }
        try { child = spawn(dockerPath, [...prefix, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false }); }
        catch (cause) { error = fail('DOCKER_START', 'Could not start Docker client'); error.cause = cause; finish(null, null, true); return; }
        timer = setTimeout(() => stop(fail('DOCKER_TIMEOUT', 'Docker client time limit reached')), timeout);
        commandSignal?.addEventListener('abort', aborted, { once: true });
        child.once('error', () => stop(fail('DOCKER_START', 'Docker client failed')));
        child.once('close', (code, killedSignal) => finish(code, killedSignal, true));
        child.stdin.on('error', () => stop(fail('WORKER_PIPE', 'Worker input pipe failed')));
        for (const [channel, pipe] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
          pipe.on('data', chunk => {
            if (done || error) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            record[`${channel}Bytes`] += bytes.length;
            const cap = stream ? OUTPUT_LIMIT : COMMAND_LIMIT;
            if (record.stdoutBytes + record.stderrBytes > cap) { stop(fail('OUTPUT_LIMIT', 'Worker output limit exceeded')); return; }
            if (stream && channel === 'stdout') {
              try { stream.onData(bytes); } catch (cause) { stop(cause); }
            } else if (!stream) {
              if (channel === 'stdout') output += bytes.toString('utf8'); else stderr += bytes.toString('utf8');
            }
          });
        }
        if (stream) stream.attach(child, stop); else child.stdin.end();
      });
    }

    async function command(args, { check = true, cleanup = false } = {}) {
      const answer = await client(args, { commandSignal: cleanup ? undefined : controller.signal });
      if (check && answer.code !== 0) throw fail('DOCKER_COMMAND', `Docker ${args[0]} failed`);
      return answer;
    }

    async function inspect(target, cleanup = false) {
      const answer = await command(['inspect', target], { cleanup });
      try { const items = JSON.parse(answer.stdout); if (items.length !== 1) throw Error(); return items[0]; }
      catch { throw fail('DOCKER_INSPECT', 'Docker inspection returned invalid data'); }
    }

    async function cleanup() {
      if (!createAttempted) { runtime.cleanup = { confirmed: true, created: false }; return; }
      if (!id) {
        const candidates = await command(['ps', '--all', '--quiet', '--no-trunc', '--filter', `label=${OWNER_LABEL}=${owner}`], { cleanup: true });
        const ids = candidates.stdout.trim() ? candidates.stdout.trim().split(/\s+/) : [];
        if (ids.length > 1 || ids.some(value => !CONTAINER.test(value))) throw fail('CLEANUP_FAILED', 'Could not identify the owned container');
        if (ids.length) {
          const existing = await inspect(ids[0], true);
          if (!owned(existing, owner)) throw fail('CLEANUP_FAILED', 'Container ownership could not be verified');
          id = existing.Id;
        }
      }
      if (id) {
        const removed = await command(['rm', '--force', id], { check: false, cleanup: true });
        runtime.cleanup.removeExit = removed.code;
      }
      const remaining = await command(['ps', '--all', '--quiet', '--no-trunc', '--filter', `label=${OWNER_LABEL}=${owner}`], { cleanup: true });
      if (remaining.stdout.trim()) throw fail('CLEANUP_FAILED', 'Owned container removal was not confirmed');
      runtime.cleanup = { ...runtime.cleanup, confirmed: true, containerAbsent: true, containerId: id ?? null };
    }

    async function executeWorker() {
      let pending = Buffer.alloc(0), child, stop, completed = false, modelInFlight = false;
      let modelWork = Promise.resolve(), modelSettled = true;
      const ids = new Set();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      async function send(frame) {
        if (controller.signal.aborted) throw controller.signal.reason;
        const encoded = encodeFrame(frame);
        if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES) throw fail('FRAME_LIMIT', 'Protocol frame exceeds its limit');
        if (!child?.stdin.writable || child.stdin.destroyed) throw fail('WORKER_PIPE', 'Worker input is closed');
        await abortable(new Promise((resolve, reject) => {
          child.stdin.write(encoded, error => error ? reject(fail('WORKER_PIPE', 'Worker input pipe failed')) : resolve());
        }), controller.signal);
      }
      function message(frame) {
        if (completed) throw fail('PROTOCOL', 'Worker sent data after completion');
        if (frame.type === 'model_request') {
          if (modelInFlight || typeof frame.id !== 'string' || !frame.id || frame.id.length > 128 || ids.has(frame.id) ||
              !modelContext(frame.context)) {
            throw fail('PROTOCOL', 'Invalid or concurrent worker model request');
          }
          ids.add(frame.id); modelInFlight = true; modelSettled = false;
          const work = Promise.resolve().then(() => onModelRequest(frame.context, controller.signal));
          work.then(() => { modelSettled = true; }, () => { modelSettled = true; });
          modelWork = abortable(work, controller.signal).then(async message => {
            if (!completed) await send({ type: 'model_response', id: frame.id, message });
          }, async () => {
            if (!completed && !controller.signal.aborted) await send({ type: 'model_error', id: frame.id, message: 'Host model request failed' });
          }).catch(error => stop(error)).finally(() => { modelInFlight = false; });
        } else if (frame.type === 'progress') {
          // Never expose worker free text, model context or private reasoning as progress.
          const stage = ['starting', 'researching', 'saving', 'complete'].includes(frame.stage) ? frame.stage : 'researching';
          try { onProgress?.({ stage }); } catch { /* Presentation must not change runtime ownership. */ }
        } else if (frame.type === 'result') {
          if (modelInFlight) throw fail('PROTOCOL', 'Worker completed while a model request was active');
          result = validateResult(frame, start); completed = true; child.stdin.end();
        } else if (frame.type === 'error') {
          throw fail('WORKER_ERROR', 'Scout worker reported a failure');
        } else throw fail('PROTOCOL', 'Unknown worker protocol message');
      }
      const stream = {
        attach(process, halt) { child = process; stop = halt; process.once('spawn', () => { send(start).catch(halt); }); },
        onData(bytes) {
          pending = Buffer.concat([pending, bytes]);
          let at;
          while ((at = pending.indexOf(10)) !== -1) {
            if (at > MAX_FRAME_BYTES) throw fail('FRAME_LIMIT', 'Worker protocol frame exceeds its limit');
            const line = pending.subarray(0, at); pending = pending.subarray(at + 1);
            if (!line.length) throw fail('PROTOCOL', 'Empty worker protocol frame');
            message(parseFrame(decoder.decode(line)));
          }
          if (pending.length > MAX_FRAME_BYTES) throw fail('FRAME_LIMIT', 'Worker protocol frame exceeds its limit');
        },
      };
      try {
        const answer = await client(['start', '--attach', '--interactive', id], {
          commandSignal: controller.signal, timeout: wallMs, stream,
        });
        if (pending.length || answer.code !== 0 || !completed) throw fail('WORKER_EXIT', 'Worker exited without a complete valid result');
        if (!modelSettled) throw fail('MODEL_CLIENT_UNSETTLED', 'Host model request did not settle');
        await modelWork;
        const state = (await inspect(id)).State;
        if (state?.Running || state?.ExitCode !== 0 || state?.OOMKilled) throw fail('WORKER_EXIT', 'Worker container did not settle successfully');
        runtime.exitCode = state.ExitCode; runtime.oomKilled = state.OOMKilled;
      } finally {
        completed = true;
        if (!modelSettled) controller.abort(fail('WORKER_STOPPED', 'Worker stopped'));
        await Promise.race([modelWork, new Promise(resolve => { const t = setTimeout(resolve, drainMs); t.unref?.(); })]);
        runtime.modelCallbackSettled = modelSettled;
      }
    }

    try {
      const imageData = await command(['image', 'inspect', image]);
      let selected;
      try { selected = JSON.parse(imageData.stdout)[0]; } catch { throw fail('IMAGE_PROFILE', 'Invalid image inspection'); }
      imageContract(selected, image);
      createAttempted = true;
      await command(['create', '--pull=never', '--name', name, '--label', `${OWNER_LABEL}=${owner}`,
        '--interactive', '--init', '--log-driver', 'none', '--network', mode === 'offline' ? 'none' : 'bridge', '--user', '1000:1000', '--read-only',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '1g', '--memory-swap', '1g',
        '--cpus', '2', '--pids-limit', '128', '--tmpfs', '/workspace:rw,nosuid,nodev,size=128m,uid=1000,gid=1000,mode=700',
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777', '--env', 'HOME=/workspace', image]);
      const created = await inspect(name);
      if (owned(created, owner)) id = created.Id;
      containerContract(created, image, mode, owner);
      await executeWorker();
    } catch (error) { failure = error; }
    finally {
      clearTimeout(wall); signal?.removeEventListener('abort', cancelled);
      try { await cleanup(); }
      catch (error) { runtime.cleanup.confirmed = false; failure = new ScoutWorkerError('CLEANUP_FAILED', 'Worker cleanup could not be confirmed', runtime, error); }
    }
    if (runtime.cleanup.confirmed && runtime.commands.some(record => !record.drained)) failure = fail('CLIENT_UNSETTLED', 'A Docker client did not settle');
    if (failure) {
      const error = failure instanceof ScoutWorkerError ? failure : new ScoutWorkerError('WORKER_FAILED', 'Scout worker failed', runtime, failure);
      error.runtime = runtime; throw error;
    }
    return { result, runtime };
  };
}

export const runScout = createDockerRunner();

import { spawn as nativeSpawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat, rename, rm, rmdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const SOURCE_LABEL = 'pi-scout.worker-source';
const FALLBACK = '/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe';
// Exact COPY inputs of the shipped Dockerfile, plus its context policy.
const INPUTS = ['.dockerignore', 'Dockerfile', 'lib/brief.mjs', 'lib/catalog.mjs',
  'lib/worker-protocol.mjs', 'research/SKILL.md', 'worker/bridge.mjs',
  'worker/index.mjs', 'worker/research.mjs', 'worker/session.mjs',
  'worker/runtime/package.json', 'worker/runtime/package-lock.json'];
const COMMAND_MS = 15000;
const BUILD_MS = 20 * 60 * 1000;
const WAIT_MS = BUILD_MS + 60000;
const OUTPUT_BYTES = 1024 * 1024;

function error(code, message) { return Object.assign(new Error(message), { code }); }
function cancelled(signal) {
  if (signal?.aborted) throw error('SETUP_CANCELLED', 'Scout setup was cancelled.');
}
function progress(callback, stage) {
  try { callback?.({ stage }); } catch { /* UI does not control setup ownership. */ }
}
function setting(value, name) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) {
    throw error('SETUP_CONFIG', `${name} must be a nonempty, single-line value.`);
  }
  return value;
}

/** Bounded subprocess capture; no shell, raw command output never enters errors. */
function command(executable, args, { signal, env, cwd, timeout = COMMAND_MS, spawn = nativeSpawn, onSpawn } = {}) {
  cancelled(signal);
  return new Promise((resolveCommand, reject) => {
    let child, timer, drain, failure, settled = false, bytes = 0, stdout = '', stderr = '';
    let observed = Promise.resolve();
    async function finish(code, processSignal, drained = true) {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(drain);
      signal?.removeEventListener('abort', abort);
      try { await observed; } catch { failure ??= error('SETUP_LOCK', 'Could not retain Scout setup process ownership.'); }
      if (!drained) {
        child?.stdout?.destroy(); child?.stderr?.destroy();
        reject(error('SETUP_UNSETTLED', 'A Scout setup process did not settle. Restart Pi after checking Docker.'));
      } else if (failure) reject(failure);
      else resolveCommand({ code, signal: processSignal, stdout, stderr });
    }
    function stop(reason) {
      if (settled || failure) return;
      failure = reason;
      drain = setTimeout(() => finish(null, null, false), 3000);
      try {
        if (process.platform !== 'win32' && child?.pid) process.kill(-child.pid, 'SIGKILL');
        else child?.kill('SIGKILL');
      } catch { try { child?.kill('SIGKILL'); } catch { /* Drain remains bounded. */ } }
    }
    function abort() { stop(error('SETUP_CANCELLED', 'Scout setup was cancelled.')); }
    try {
      child = spawn(executable, args, { env, cwd, shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (cause) {
      reject(error(cause.code === 'ENOENT' ? 'CLIENT_MISSING' : 'CLIENT_START', 'Could not start the selected Docker client.'));
      return;
    }
    timer = setTimeout(() => stop(error('SETUP_TIMEOUT', 'Scout setup command timed out. Check Docker and try again.')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', cause => {
      failure ??= error(cause.code === 'ENOENT' ? 'CLIENT_MISSING' : 'CLIENT_START', 'Could not start the selected Docker client.');
    });
    child.once('close', (code, processSignal) => finish(code, processSignal));
    observed = Promise.resolve().then(() => onSpawn?.(child.pid));
    observed.catch(() => stop(error('SETUP_LOCK', 'Could not retain Scout setup process ownership.')));
    for (const [name, pipe] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
      pipe.on('data', chunk => {
        if (settled || failure) return;
        bytes += chunk.length;
        if (bytes > OUTPUT_BYTES) { stop(error('SETUP_OUTPUT_LIMIT', 'Scout setup output exceeded its limit.')); return; }
        if (name === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
      });
    }
  });
}

async function sourceHash(root) {
  const hash = createHash('sha256');
  hash.update('pi-scout-worker-source-v1\0');
  for (const path of INPUTS) {
    const file = join(root, path);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) {
      throw error('SETUP_SOURCE', 'The installed Scout worker source is not a regular supported package. Reinstall Scout.');
    }
    const bytes = await readFile(file);
    hash.update(`${Buffer.byteLength(path)}:${path}:${bytes.length}:`); hash.update(bytes);
  }
  return hash.digest('hex');
}

async function wsl(env) {
  if (process.platform !== 'linux') return false;
  if (env.WSL_DISTRO_NAME) return true;
  try { return /microsoft/i.test(await readFile('/proc/sys/kernel/osrelease', 'utf8')); }
  catch { return false; }
}

async function selectClient(env, options) {
  const explicit = env.PI_SCOUT_DOCKER_PATH !== undefined;
  let dockerPath = explicit ? setting(env.PI_SCOUT_DOCKER_PATH, 'PI_SCOUT_DOCKER_PATH') : 'docker';
  const host = env.PI_SCOUT_DOCKER_HOST === undefined ? undefined : setting(env.PI_SCOUT_DOCKER_HOST, 'PI_SCOUT_DOCKER_HOST');
  let dockerArgs = host ? ['--host', host] : [];
  let version, missing = false;
  try { version = await command(dockerPath, [...dockerArgs, '--version'], options); }
  catch (failure) { if (failure.code === 'CLIENT_MISSING') missing = true; else throw failure; }
  const stub = version?.code !== 0 && /could not be found in this WSL|activate the WSL integration/i.test(`${version?.stdout}\n${version?.stderr}`);
  if (!explicit && (missing || stub) && await wsl(options.env)) {
    dockerPath = options.desktopPath;
    const selectedEndpoint = options.env.DOCKER_HOST || options.env.DOCKER_CONTEXT;
    dockerArgs = host ? ['--host', host] : selectedEndpoint ? [] : ['--host', 'npipe:////./pipe/dockerDesktopLinuxEngine'];
    try { version = await command(dockerPath, [...dockerArgs, '--version'], options); missing = false; }
    catch (failure) { if (failure.code === 'CLIENT_MISSING') missing = true; else throw failure; }
  }
  if (missing || stub && dockerPath === 'docker') {
    throw error('DOCKER_MISSING', 'Docker is not installed or available to Pi. Install Docker Desktop or select PI_SCOUT_DOCKER_PATH.');
  }
  if (version?.code !== 0) throw error('DOCKER_CLIENT', 'The selected Docker client could not run. Check its installation.');
  const info = await command(dockerPath, [...dockerArgs, 'info', '--format', '{{.OSType}}'], options);
  if (info.code !== 0) {
    throw error('DOCKER_UNAVAILABLE', 'Docker is installed but its selected engine is not reachable. Start or reconnect that engine, then retry Scout.');
  }
  if (info.stdout.trim() !== 'linux') throw error('DOCKER_PLATFORM', 'Scout requires a Linux-container Docker engine.');
  return { dockerPath, dockerArgs };
}

async function inspect(client, name, options) {
  const answer = await command(client.dockerPath, [...client.dockerArgs, 'image', 'inspect', name], options);
  if (answer.code !== 0) {
    if (/no such image|image.*not found|not found.*image/i.test(`${answer.stdout}\n${answer.stderr}`)) return null;
    throw error('DOCKER_INSPECT', 'Docker could not inspect the Scout image. Check the selected engine.');
  }
  try {
    const images = JSON.parse(answer.stdout);
    if (images.length !== 1 || !IMAGE_ID.test(images[0]?.Id ?? '')) throw Error();
    return images[0];
  } catch { throw error('DOCKER_INSPECT', 'Docker returned an invalid Scout image identity.'); }
}

function dead(pid, group = false) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(group ? -pid : pid, 0); return false; }
  catch (failure) { return failure.code === 'ESRCH'; }
}
async function readOwner(lock) {
  try { return JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')); }
  catch { return null; }
}
async function reclaim(lock) {
  const marker = join(lock, 'recovery');
  let moved = false;
  try { await mkdir(marker); } catch { return; }
  try {
    const owner = await readOwner(lock);
    if (!owner || !dead(owner.pid) || owner.state === 'starting' ||
        owner.state === 'running' && (!owner.recoverable || !dead(owner.childPid, owner.processGroup === true)) ||
        !['idle', 'running'].includes(owner.state)) return;
    const retired = `${lock}.dead-${randomUUID()}`;
    await rename(lock, retired);
    moved = true;
    await rm(retired, { recursive: true, force: true });
  } catch (failure) { if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(failure.code)) throw failure; }
  finally { if (!moved) await rmdir(marker).catch(() => {}); }
}
async function acquire(lock, signal, onProgress) {
  const token = randomUUID(), began = Date.now();
  let uncertainSince, waitingReported = false;
  const owner = { pid: process.pid, token, state: 'idle' };
  async function record(state) {
    const temporary = join(lock, `owner-${token}.tmp`);
    await writeFile(temporary, JSON.stringify({ ...owner, ...state }), { mode: 0o600 });
    await rename(temporary, join(lock, 'owner.json'));
  }
  for (;;) {
    cancelled(signal);
    try {
      await mkdir(lock, { mode: 0o700 });
      try { await writeFile(join(lock, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); }
      catch (failure) { await rmdir(lock).catch(() => {}); throw failure; }
      return { record, release: async () => {
        if ((await readOwner(lock))?.token !== token) return;
        await unlink(join(lock, 'owner.json'));
        // Do not remove a contender's recovery marker recursively. Keeping the
        // directory until that observer leaves also prevents pathname reuse.
        for (let n = 0; n < 150; n++) {
          try { await rmdir(lock); return; }
          catch (failure) { if (failure.code === 'ENOENT') return; if (failure.code !== 'ENOTEMPTY') throw failure; }
          await delay(20);
        }
        throw error('SETUP_LOCK_RELEASE', 'Scout setup completed, but its ownership lock could not be released. Check the setup cache before retrying.');
      } };
    } catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
    if (!waitingReported) { progress(onProgress, 'waiting for another Scout setup'); waitingReported = true; }
    const existing = await readOwner(lock);
    const valid = existing && Number.isSafeInteger(existing.pid) && existing.pid > 0 &&
      typeof existing.token === 'string' && existing.token && ['idle', 'starting', 'running'].includes(existing.state) &&
      (existing.state !== 'running' || Number.isSafeInteger(existing.childPid) && existing.childPid > 0);
    let recovering = false;
    try { await lstat(join(lock, 'recovery')); recovering = true; } catch { /* No marker. */ }
    if (!valid || recovering) {
      uncertainSince ??= Date.now();
      if (Date.now() - uncertainSince > 2000) {
        throw error('SETUP_LOCK_UNCERTAIN', 'Scout found an incomplete setup lock. Its ownership cannot be verified; inspect the setup cache before retrying.');
      }
    } else {
      uncertainSince = undefined;
      if (dead(existing.pid) && (existing.state === 'starting' || existing.state === 'running' && !existing.recoverable)) {
        throw error('SETUP_LOCK_UNCERTAIN', 'A previous Scout setup ended without proving its build client stopped. Check Docker and the setup cache before retrying.');
      }
    }
    await reclaim(lock);
    if (Date.now() - began > WAIT_MS) throw error('SETUP_BUSY', 'Another Scout setup has not settled. Check the existing Pi process before retrying.');
    try { await delay(200, undefined, { signal }); }
    catch { throw error('SETUP_CANCELLED', 'Scout setup was cancelled.'); }
  }
}

/** Dependency injection is host-side only; models cannot select a setup client. */
export function createWorkerSetup({ spawn = nativeSpawn, desktopPath = FALLBACK } = {}) {
return async function prepareWorker({ signal, onProgress, env = process.env,
  packageRoot = fileURLToPath(new URL('../', import.meta.url)),
  cacheRoot = join(homedir(), '.pi-scout-research', 'setup') } = {}) {
  cancelled(signal);
  const mode = env.PI_SCOUT_WORKER_MODE ?? 'public';
  if (!['offline', 'public'].includes(mode)) throw error('SETUP_CONFIG', 'PI_SCOUT_WORKER_MODE must be public or offline.');
  const override = env.PI_SCOUT_WORKER_IMAGE;
  if (override !== undefined && !IMAGE_ID.test(override)) {
    throw error('SETUP_IMAGE', 'PI_SCOUT_WORKER_IMAGE must be an immutable sha256 image ID. Clear the override to use automatic setup.');
  }
  const root = resolve(packageRoot);
  const options = { signal, env: { ...process.env, ...env }, cwd: root, spawn, desktopPath };
  progress(onProgress, 'checking');
  const client = await selectClient(env, options);
  if (override !== undefined) {
    const selected = await inspect(client, override, options);
    if (selected?.Id !== override) throw error('SETUP_IMAGE_MISSING', 'The explicitly selected Scout image is missing from this Docker engine. Restore it or clear PI_SCOUT_WORKER_IMAGE.');
    progress(onProgress, 'ready');
    return { ...client, image: override, mode };
  }
  let hash;
  try { hash = await sourceHash(root); }
  catch (failure) { throw error('SETUP_SOURCE', 'The installed Scout worker source is missing or invalid. Reinstall Scout.'); }
  const tag = `pi-scout-worker:source-${hash}`;
  const matching = async () => {
    const image = await inspect(client, tag, options);
    return image?.Config?.Labels?.[SOURCE_LABEL] === hash ? image.Id : null;
  };
  let image = await matching();
  if (image) { progress(onProgress, 'ready'); return { ...client, image, mode }; }
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const lock = await acquire(join(cacheRoot, `${hash}.lock`), signal, onProgress);
  let releaseAllowed = true;
  try {
    image = await matching();
    if (!image) {
      cancelled(signal);
      let context = root;
      if (process.platform === 'linux' && /\.exe$/i.test(client.dockerPath)) {
        let mapped;
        try { mapped = await command('wslpath', ['-w', root], options); }
        catch (failure) {
          if (!['CLIENT_MISSING', 'CLIENT_START'].includes(failure.code)) throw failure;
          throw error('SETUP_PATH', 'Windows Docker requires wslpath to translate the installed Scout directory.');
        }
        context = mapped.stdout.trim();
        if (mapped.code !== 0 || !/^(?:[a-z]:\\|\\\\)/i.test(context) || /[\r\n\0]/.test(context)) {
          throw error('SETUP_PATH', 'Could not translate the installed Scout path for Windows Docker.');
        }
      }
      progress(onProgress, 'building');
      // A killed parent can leave its detached client alive. Mark the uncertain
      // spawn interval first, then bind recovery to the observed client/group.
      await lock.record({ state: 'starting' });
      const built = await command(client.dockerPath, [...client.dockerArgs, 'build', '--tag', tag,
        '--label', `${SOURCE_LABEL}=${hash}`, context], { ...options, timeout: BUILD_MS,
        onSpawn: childPid => lock.record({ state: 'running', childPid, processGroup: process.platform !== 'win32',
          recoverable: process.platform !== 'win32' && !/\.exe$/i.test(client.dockerPath) }) });
      await lock.record({ state: 'idle' });
      if (built.code !== 0) throw error('SETUP_BUILD', 'Scout worker build failed. Check Docker, network access and available disk space, then retry.');
      if (await sourceHash(root) !== hash) throw error('SETUP_SOURCE_CHANGED', 'Scout changed during its worker build. Retry after the installation finishes.');
      image = await matching();
      if (!image) throw error('SETUP_IMAGE', 'The built Scout image did not match its packaged source identity.');
    }
    cancelled(signal);
    progress(onProgress, 'ready');
    return { ...client, image, mode };
  } catch (failure) {
    if (failure.code === 'SETUP_UNSETTLED') releaseAllowed = false;
    throw failure;
  } finally { if (releaseAllowed) await lock.release(); }
};
}

/** Prepare a pinned worker lazily. Operator overrides never silently fall back. */
export const prepareWorker = createWorkerSetup();

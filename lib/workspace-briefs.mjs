import { constants } from 'node:fs';
import { lstat, realpath, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from './catalog.mjs';
import { validateReference, referenceKey } from './brief-reference.mjs';

export const MAX_WORKSPACE_REFS = 40;
const MAX_INDEX_BYTES = 65536;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The path alone is not ownership: deleting/replacing a workspace invalidates its index.
export async function workspaceIdentity(cwd) {
  const path = await realpath(cwd), stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Workspace unavailable');
  return { path, dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}
export async function workspaceCurrent(identity) {
  try { return same(await workspaceIdentity(identity.path), identity); } catch { return false; }
}
function record(value) {
  if (!value || !['local', 'worker'].includes(value.kind) || typeof value.savedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.savedAt))) throw Error('Invalid workspace reference');
  const destination = value.destination;
  if (destination !== null && (!destination || !['provider', 'model', 'api', 'endpoint'].every(key => typeof destination[key] === 'string' &&
      destination[key].length > 0 && destination[key].length < 512) || !/^[a-f0-9]{64}$/.test(destination.endpoint))) throw Error('Invalid destination');
  return { kind: value.kind, reference: validateReference(value.reference),
    destination: destination === null ? null : { provider: destination.provider, model: destination.model, api: destination.api, endpoint: destination.endpoint },
    savedAt: value.savedAt, researchStatus: ['complete', 'incomplete'].includes(value.researchStatus) ? value.researchStatus : 'unknown',
    ...(value.researchIssue === 'BRIEF_UPDATE_REJECTED' ? { researchIssue: value.researchIssue } : {}) };
}
async function indexPath(root, identity, create = false) {
  const canonical = await realpath(root), directory = join(canonical, '.workspaces');
  if (create) await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || dirname(await realpath(directory)) !== canonical ||
      process.platform !== 'win32' && (stat.mode & 0o077)) throw Error('Index unavailable');
  return join(directory, `${digest(identity.path)}.json`);
}
async function readIndex(file, identity) {
  let handle;
  try {
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_INDEX_BYTES ||
        process.platform !== 'win32' && (before.mode & 0o077)) throw Error('Index unavailable');
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) throw Error('Index changed');
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const part = await handle.read(bytes, length, bytes.length - length, length);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    const after = await lstat(file);
    if (length !== before.size || after.ino !== stat.ino || after.dev !== stat.dev || after.mtimeMs !== stat.mtimeMs) throw Error('Index changed');
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
    if (parsed.version !== 1 || !same(parsed.workspace, identity) || !Array.isArray(parsed.records) || parsed.records.length > MAX_WORKSPACE_REFS) throw Error('Index owner mismatch');
    return { records: parsed.records.map(record), truncated: parsed.truncated === true };
  } finally { await handle?.close(); }
}

/** Exact workspace index only; never enumerate the private brief store or other sessions. */
export async function readWorkspaceBriefs(root, identity) {
  try {
    if (!await workspaceCurrent(identity)) return { state: 'unavailable', records: [] };
    const result = await readIndex(await indexPath(root, identity), identity);
    if (!await workspaceCurrent(identity)) return { state: 'unavailable', records: [] };
    return { state: 'available', ...result };
  } catch (error) { return { state: error?.code === 'ENOENT' ? 'unknown' : 'unavailable', records: [] }; }
}

/** Optional, metadata-only bookkeeping. A failed index write never invalidates a saved brief. */
export async function rememberWorkspaceBrief(root, identity, input, { authorize = () => true } = {}) {
  let lock, temporary, file;
  try {
    const next = record(input);
    if (!await authorize() || !await workspaceCurrent(identity)) return false;
    file = await indexPath(root, identity, true);
    lock = await open(`${file}.lock`, 'wx', 0o600); // Never reclaim an uncertain writer's lock.
    let previous = { records: [], truncated: false };
    try { previous = await readIndex(file, identity); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const records = [...previous.records.filter(item => referenceKey(item.reference) !== referenceKey(next.reference)), next];
    const body = Buffer.from(`${JSON.stringify({ version: 1, workspace: identity,
      truncated: previous.truncated || records.length > MAX_WORKSPACE_REFS, records: records.slice(-MAX_WORKSPACE_REFS) })}\n`);
    if (body.length > MAX_INDEX_BYTES || !await authorize() || !await workspaceCurrent(identity)) return false;
    temporary = `${file}.${randomUUID()}.tmp`;
    const output = await open(temporary, 'wx', 0o600);
    try { await output.writeFile(body); await output.sync(); } finally { await output.close(); }
    if (!await authorize() || !await workspaceCurrent(identity)) return false;
    await rename(temporary, file); temporary = undefined;
    return true;
  } catch { return false; }
  finally {
    if (temporary) await unlink(temporary).catch(() => {});
    if (lock) { await lock.close().catch(() => {}); await unlink(`${file}.lock`).catch(() => {}); }
  }
}

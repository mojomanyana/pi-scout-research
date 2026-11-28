import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function ecosystemConfigPath(env = process.env) {
  const dir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent');
  return join(dir, 'ecosystem.json');
}

/**
 * Reads optional `~/.pi/agent/ecosystem.json` (or `$PI_CODING_AGENT_DIR/ecosystem.json`).
 * Never throws. Saved `scout.*` settings in ecosystem.json override legacy `PI_SCOUT_*` env vars.
 */
export function loadEcosystemConfig(env = process.env) {
  const file = ecosystemConfigPath(env);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Persist a new default Scout model to ecosystem.json while preserving all other operator settings. */
export function saveScoutModelDefault(modelId, env = process.env) {
  const file = ecosystemConfigPath(env);
  const existing = loadEcosystemConfig(env);
  const next = { ...existing, scout: { ...(existing.scout ?? {}), model: modelId } };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
  return file;
}

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Reads optional `~/.pi/agent/ecosystem.json` (or `$PI_CODING_AGENT_DIR/ecosystem.json`).
 * Never throws; explicit environment variables always take precedence over file values.
 */
export function loadEcosystemConfig(env = process.env) {
  const dir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent');
  const file = join(dir, 'ecosystem.json');
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

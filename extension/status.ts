import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { branchReferences } from '../lib/brief-reference.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { researchInventory } from '../lib/research-inventory.mjs';
import { workspaceIdentity, workspaceCurrent } from '../lib/workspace-briefs.mjs';
import { probeLocalDocker } from '../lib/worker-setup.mjs';

// Optional terminal observation only. Daddy absence does not delay research.
export function scoutStatus(pi: ExtensionAPI, kind: 'local' | 'worker', options: {
  readiness?: (ctx: ExtensionContext, signal: AbortSignal) => Promise<any>;
  workerState?: () => { busy: boolean; cleanupBlocked: boolean };
  dockerConfiguration?: Record<string, string>;
} = {}) {
  let publish: ((value: unknown) => boolean) | undefined;
  let close: (() => void) | undefined;
  let generation = 0, sequence = 0;
  let owner: { sessionId: string; cwd: string } | undefined;
  let items: unknown[] = [];
  let inventory: any, supportsInventory = false, availability: any;
  const root = process.env.PI_SCOUT_BRIEFS ?? join(homedir(), '.pi-scout-research', 'briefs');
  const activeAvailability = () => {
    const state = options.workerState?.();
    if (state?.cleanupBlocked) return { state: 'unavailable', label: 'Research cleanup unresolved', details: ['A current setup, worker or model operation did not settle. A Docker probe cannot clear this guard.'] };
    if (state?.busy) return { state: 'running', label: 'Research in progress', details: ['The current research operation owns worker readiness; no extra Docker check was made.'] };
    return undefined;
  };
  const readiness = async (ctx: ExtensionContext, signal: AbortSignal) => {
    if (options.readiness) return options.readiness(ctx, signal);
    if (kind !== 'worker') return undefined;
    const active = activeAvailability();
    if (active) return active;
    const checked = await probeLocalDocker({ env: options.dockerConfiguration, signal });
    return activeAvailability() ?? checked;
  };
  const update = () => {
    const status = activeAvailability() ?? availability;
    return { sequence: ++sequence, items: [...items, ...(status ? [{ id: 'availability', kind: 'status', ...status }] : [])],
      ...(supportsInventory && inventory ? { inventory } : {}) };
  };
  const send = () => { try { publish?.(update()); } catch { publish = undefined; } };
  const reset = () => { generation++; try { close?.(); } catch { /* Observation cannot block research. */ } publish = undefined; close = undefined; owner = undefined; items = []; inventory = undefined; availability = undefined; supportsInventory = false; };
  const observe = (ctx: ExtensionContext, state = 'observed', details: string[] = []) => {
    if (!ctx.cwd || !ctx.sessionManager?.getSessionId) return;
    const sessionId = ctx.sessionManager.getSessionId(), cwd = ctx.cwd;
    if (owner?.sessionId !== sessionId || owner?.cwd !== cwd) {
      reset(); owner = { sessionId, cwd };
      const attempt = generation;
      const workspace = workspaceIdentity(cwd).catch(() => undefined);
      const current = () => attempt === generation && owner?.sessionId === sessionId && owner?.cwd === cwd && ctx.sessionManager.getSessionId() === sessionId && ctx.cwd === cwd;
      try { pi.events.emit('pi-daddy:dashboard-source:v1', { version: 1, sessionId, cwd,
        producer: `scout-${kind}`, producerVersion: '0.3.0',
        refresh: async ({ signal }: { signal: AbortSignal }) => {
          const identity = await workspace;
          if (!current() || signal.aborted) return undefined;
          if (!identity || !await workspaceCurrent(identity)) return { sequence: ++sequence,
            items: [{ id: 'availability', kind: 'status', state: 'unavailable', label: 'Workspace unavailable', details: ['The workspace was deleted, replaced or cannot be read.'] }],
            ...(supportsInventory ? { inventory: { scope: 'Current workspace', state: 'unavailable', summary: 'Workspace ownership changed; saved previews are withheld.', limited: true, entries: [] } } : {}) };
          const [nextInventory, nextAvailability] = await Promise.all([
            supportsInventory ? researchInventory({ root, ctx, kind, signal, current }) : undefined,
            readiness(ctx, signal),
          ]);
          if (!current() || signal.aborted || !await workspaceCurrent(identity)) return undefined;
          inventory = nextInventory;
          availability = nextAvailability ?? availability;
          return update(); // The host owns publication and late-result fencing for refresh.
        }, reply: (reply: any) => {
          if (attempt !== generation) { try { if (reply?.ok) reply.close(); } catch { /* Detached observer. */ } return; }
          if (reply?.ok) { supportsInventory = reply.capabilities?.inventory === 1; publish = reply.publish; close = reply.close; send(); }
        } }); } catch { /* An absent or broken optional observer is not a research failure. */ }
    }
    const saved = branchReferences(ctx.sessionManager.getBranch()).filter(item =>
      kind === 'worker' ? typeof item.requestId === 'string' : typeof item.requestId !== 'string').at(-1);
    const incomplete = saved?.researchStatus === 'incomplete';
    const partialCurrent = incomplete && ['observed', 'settled'].includes(state);
    // Settled describes the worker lifecycle, not complete research coverage.
    // Daddy maps an unobserved worker to "Docker untested", so keep that distinct
    // from a retained partial brief whose cleanup has already settled.
    const workState = partialCurrent ? 'settled' : state;
    availability = undefined;
    items = [{ id: 'research', kind: 'work', label: partialCurrent ? 'Scout research · partial findings saved'
        : kind === 'worker' ? 'Scout Docker research' : 'Scout local evidence', state: workState,
      details: partialCurrent && !details.length ? ['Saved evidence has unresolved gaps. No human decision is requested by this record.'] : details },
      ...(saved ? [{ id: 'brief', kind: 'evidence', label: incomplete ? 'Partial research saved · gaps remain' : 'Exact research brief retained', state: 'observed',
        reference: JSON.stringify(saved.reference), details: [incomplete ? (saved.researchIssue === 'BRIEF_UPDATE_REJECTED'
          ? 'The last update was not saved. The previous validated draft is retained; research is incomplete.'
          : 'Research is incomplete. Read the saved findings and gaps before continuing; do not treat this as task completion.')
          : saved.researchStatus === 'complete' ? 'Research coverage reported complete; semantic approval is not implied.'
          : 'Completion status was not recorded. Inspect the saved brief before reuse.',
        'Untrusted evidence; semantic approval is not implied.'] }] : [])];
    const failure = kind === 'worker' && ctx.sessionManager.getBranch().findLast(entry => entry.type === 'custom' && entry.customType === 'scout-worker-failure-v1');
    if (failure) items.push({ id: 'last-failure', kind: 'evidence', state: 'observed', label: 'Last recorded research failure',
      details: [failure.data?.summary, failure.data?.nextStep].filter(value => typeof value === 'string').map(value => value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240)) });
    send();
  };
  for (const event of ['session_start', 'session_switch', 'session_fork', 'session_tree', 'model_select'] as const) {
    pi.on(event, (_event, ctx) => { reset(); observe(ctx); });
  }
  pi.on('session_shutdown', reset);
  return Object.assign(observe, { sync: send });
}

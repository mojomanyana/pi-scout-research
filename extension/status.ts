import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { branchReferences } from '../lib/brief-reference.mjs';

// Optional terminal observation only. Daddy absence does not delay research.
export function scoutStatus(pi: ExtensionAPI, kind: 'local' | 'worker') {
  let publish: ((value: unknown) => boolean) | undefined;
  let close: (() => void) | undefined;
  let generation = 0, sequence = 0;
  let owner: { sessionId: string; cwd: string } | undefined;
  let items: unknown[] = [];
  const send = () => { try { publish?.({ sequence: ++sequence, items }); } catch { publish = undefined; } };
  const reset = () => { generation++; try { close?.(); } catch { /* Observation cannot block research. */ } publish = undefined; close = undefined; owner = undefined; items = []; };
  const observe = (ctx: ExtensionContext, state = 'observed', details: string[] = []) => {
    if (!ctx.cwd || !ctx.sessionManager?.getSessionId) return;
    const sessionId = ctx.sessionManager.getSessionId(), cwd = ctx.cwd;
    if (owner?.sessionId !== sessionId || owner?.cwd !== cwd) {
      reset(); owner = { sessionId, cwd };
      const attempt = generation;
      try { pi.events.emit('pi-daddy:dashboard-source:v1', { version: 1, sessionId, cwd,
        producer: `scout-${kind}`, producerVersion: '0.1.1+ecosystem-b', reply: (reply: any) => {
          if (attempt !== generation) { try { if (reply?.ok) reply.close(); } catch { /* Detached observer. */ } return; }
          if (reply?.ok) { publish = reply.publish; close = reply.close; send(); }
        } }); } catch { /* An absent or broken optional observer is not a research failure. */ }
    }
    const saved = branchReferences(ctx.sessionManager.getBranch()).filter(item =>
      kind === 'worker' ? typeof item.requestId === 'string' : typeof item.requestId !== 'string').at(-1);
    items = [{ id: 'research', kind: 'work', label: kind === 'worker' ? 'Scout Docker research' : 'Scout local evidence', state, details },
      ...(saved ? [{ id: 'brief', kind: 'evidence', label: 'Exact research brief retained', state: 'observed',
        reference: JSON.stringify(saved.reference), details: ['Untrusted evidence; semantic approval is not implied.'] }] : [])];
    send();
  };
  for (const event of ['session_start', 'session_switch', 'session_fork', 'session_tree'] as const) {
    pi.on(event, (_event, ctx) => { reset(); observe(ctx); });
  }
  pi.on('session_shutdown', reset);
  return observe;
}

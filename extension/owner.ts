import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

export function scoutOwner(pi: ExtensionAPI) {
  let epoch = 0;
  for (const event of ['session_start', 'session_switch', 'session_fork', 'session_tree', 'session_shutdown'] as const)
    pi.on(event, () => { epoch++; });
  return (ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId(), observed = epoch;
    return { sessionId, current: () => epoch === observed && ctx.sessionManager.getSessionId() === sessionId };
  };
}

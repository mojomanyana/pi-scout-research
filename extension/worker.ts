import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BriefStore } from '../lib/brief.mjs';
import { referenceNotice, destinationIdentity } from '../lib/brief-reference.mjs';
import { createRequest, validateSources } from '../lib/worker-protocol.mjs';
import { runScout } from '../lib/docker-worker.mjs';
import { prepareWorker } from '../lib/worker-setup.mjs';
import { scoutStatus } from './status.ts';
import { scoutOwner } from './owner.ts';

export default function scoutWorker(pi: ExtensionAPI) {
  const observe = scoutStatus(pi, 'worker');
  const captureOwner = scoutOwner(pi);
  const configuration = Object.fromEntries(['PI_SCOUT_WORKER_IMAGE', 'PI_SCOUT_WORKER_MODE',
    'PI_SCOUT_DOCKER_PATH', 'PI_SCOUT_DOCKER_HOST'].flatMap(key =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  const briefs = new BriefStore(process.env.PI_SCOUT_BRIEFS ?? join(homedir(), '.pi-scout-research', 'briefs'));
  let busy = false;
  let cleanupBlocked = false;
  pi.registerTool({
    name: 'scout_research', label: 'Scout research',
    description: 'Research a public question in a separate Docker worker and return a sourced brief. Use for external facts, documentation, comparisons and investigation. Send only an explicit public question and scope, never private repository contents, credentials or conversation history. The worker uses the current Pi model through the parent; Docker public mode does not enforce every outbound URL. No publishing or implementation work.',
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 4000 }),
      scope: Type.String({ minLength: 1, maxLength: 4000 }),
    }, { additionalProperties: false }),
    async execute(_id, args, signal, update, ctx) {
      if (!ctx.model) throw new Error('Select a Pi model before invoking Scout');
      if (cleanupBlocked) throw new Error('An earlier Scout setup, worker or model request did not settle. Inspect Docker and the recorded cleanup status before starting another Scout session.');
      if (busy) throw new Error('A Scout worker is already running in this Pi session');
      const selectedModel = ctx.model;
      const thinking = pi.getThinkingLevel();
      const owner = captureOwner(ctx);
      busy = true;
      try {
        observe(ctx, 'running', ['Preparing isolated research worker.']);
        const destination = await destinationIdentity(ctx);
        let sources = [];
        if (process.env.PI_SCOUT_CATALOG) {
          const data = await readFile(process.env.PI_SCOUT_CATALOG);
          if (data.length > 1024 * 1024) throw new Error('Worker catalog exceeds 1 MiB');
          const catalog = JSON.parse(data.toString('utf8'));
          if (catalog.version !== 1) throw new Error('Unsupported catalog version');
          sources = validateSources(catalog.sources);
        }
        const request = createRequest({ ...args, mode: configuration.PI_SCOUT_WORKER_MODE ?? 'public', sources, model: selectedModel,
          thinkingLevel: thinking });
        const { image, mode, dockerPath, dockerArgs } = await prepareWorker({ env: configuration, signal,
          onProgress: ({ stage }: { stage: string }) => update?.({ content: [{ type: 'text', text: stage === 'building'
            ? 'Scout: preparing the research worker for first use. This can take a few minutes.' : `Scout: ${stage}` }], details: { stage } }),
        });
        const completed = await runScout({ request, image, signal,
          dockerPath, dockerArgs,
          onProgress: ({ stage }: { stage: string }) => update?.({ content: [{ type: 'text', text: `Scout: ${stage}` }], details: { stage } }),
          onModelRequest: async (context: unknown, modelSignal: AbortSignal) => {
            // Pi resolves the selected provider and credentials in the parent.
            // Only the isolated worker's public conversation crosses this boundary.
            const stream = ctx.modelRegistry.streamSimple(selectedModel, context as any, {
              signal: modelSignal, ...(thinking === 'off' ? {} : { reasoning: thinking }),
            });
            const message = await stream.result();
            if (message.stopReason === 'error' || message.stopReason === 'aborted') {
              throw new Error('The selected Pi model did not complete the research turn');
            }
            return message;
          },
        });
        const saved = await briefs.save(owner.sessionId, completed.result.brief);
        const currentDestination = await destinationIdentity(ctx);
        if (!owner.current()) return { content: [{ type: 'text', text: 'Scout completed for the previous session branch. Its brief was retained under the original owner; output is withheld from the new branch.' }],
          details: { outputWithheld: true, reason: 'owner-changed', cleanup: completed.runtime.cleanup } };
        pi.appendEntry('scout-worker-brief-v2', { requestId: request.requestId,
          reference: saved.reference, destination, image, mode });
        observe(ctx, 'settled', ['Worker cleanup confirmed; brief retained.']);
        if (JSON.stringify(currentDestination) !== JSON.stringify(destination)) {
          return { content: [{ type: 'text', text: 'Scout completed and saved its brief, but the model destination changed. Retrieve the exact reference only after authorizing the new destination.' }],
            details: { briefReference: saved.reference, outputWithheld: true, cleanup: completed.runtime.cleanup,
              semanticApproval: false, protectedOnline: false } };
        }
        const details = { ...completed, briefPath: saved.path, briefSha256: saved.sha256,
          briefReference: saved.reference,
          semanticApproval: false, protectedOnline: false };
        return { content: [{ type: 'text', text: `${completed.result.answer}\n\nScout brief saved: ${saved.path}\nScout worker cleanup: confirmed.` }], details };
      } catch (error) {
        if (error?.code === 'SETUP_UNSETTLED' || error?.runtime && (error.runtime.cleanup?.confirmed !== true || error.runtime.modelCallbackSettled === false)) {
          cleanupBlocked = true;
        }
        observe(ctx, cleanupBlocked ? 'unknown' : 'failed', [cleanupBlocked ? 'Settlement is uncertain; another worker is blocked.' : 'Research did not complete. Inspect the Pi tool result.']);
        throw error;
      } finally { busy = false; }
    },
  });
  pi.on('context', async (event, ctx) => {
    const notice = referenceNotice(ctx.sessionManager.getBranch(), 'worker');
    const messages = event.messages.filter(message =>
      !(message.role === 'custom' && message.customType === 'scout-worker-context'));
    if (!notice) return messages.length === event.messages.length ? undefined : { messages };
    return { messages: [...messages, { role: 'custom', customType: 'scout-worker-context',
      content: notice,
      display: false, timestamp: Date.now() }] };
  });
}

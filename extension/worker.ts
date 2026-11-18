import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BriefStore } from '../lib/brief.mjs';
import { destinationIdentity } from '../lib/brief-reference.mjs';
import { placeReferenceNotice } from '../lib/notice-placement.mjs';
import { createRequest, validateSources } from '../lib/worker-protocol.mjs';
import { runScout } from '../lib/docker-worker.mjs';
import { prepareWorker } from '../lib/worker-setup.mjs';
import { scoutFailure, failureReceipt, failureText } from '../lib/worker-failure.mjs';
import { usageText } from '../lib/worker-usage.mjs';
import { scoutStatus } from './status.ts';
import { scoutOwner } from './owner.ts';
import { workspaceIdentity, rememberWorkspaceBrief } from '../lib/workspace-briefs.mjs';

export default function scoutWorker(pi: ExtensionAPI) {
  const captureOwner = scoutOwner(pi);
  const configuration = Object.fromEntries(['PI_SCOUT_WORKER_IMAGE', 'PI_SCOUT_WORKER_MODE',
    'PI_SCOUT_DOCKER_PATH', 'PI_SCOUT_DOCKER_HOST'].flatMap(key =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  const briefs = new BriefStore(process.env.PI_SCOUT_BRIEFS ?? join(homedir(), '.pi-scout-research', 'briefs'));
  let busy = false;
  let cleanupBlocked = false;
  const observe = scoutStatus(pi, 'worker', { dockerConfiguration: configuration, workerState: () => ({ busy, cleanupBlocked }) });
  pi.registerTool({
    name: 'scout_research', label: 'Scout research',
    description: 'Research a public question in a separate Docker worker and return a sourced brief, explicitly incomplete when gaps remain. Use for external facts, documentation, comparisons and investigation. Optionally supply known exact official documentation URLs in sourceUrls so the worker can fetch them directly without a search prerequisite. Send only public question, scope and URLs, never private repository contents, credentials or conversation history. The worker uses the current Pi model through the parent; Docker public mode does not enforce every outbound URL. No publishing or implementation work.',
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 4000 }),
      scope: Type.String({ minLength: 1, maxLength: 4000 }),
      sourceUrls: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 6, uniqueItems: true,
        description: 'Known exact public HTTPS source URLs; no credentials or fragments. Public mode only. These are retrieval targets, not proof of official ownership or evidence already checked.' })),
    }, { additionalProperties: false }),
    async execute(_id, args, signal, update, ctx) {
      if (!ctx.model) throw new Error('Select a Pi model before invoking Scout');
      if (cleanupBlocked) throw new Error('An earlier Scout setup, worker or model request did not settle. Inspect Docker and the recorded cleanup status before starting another Scout session.');
      if (busy) throw new Error('A Scout worker is already running in this Pi session');
      const selectedModel = ctx.model;
      const thinking = pi.getThinkingLevel();
      const owner = captureOwner(ctx);
      let requestId: string | undefined;
      let phase = 'setup';
      busy = true;
      try {
        const workspace = await workspaceIdentity(ctx.cwd).catch(() => undefined);
        observe(ctx, 'running', ['Preparing isolated research worker.']);
        const destination = await destinationIdentity(ctx);
        let sources = [];
        if (process.env.PI_SCOUT_CATALOG) {
          try {
            const data = await readFile(process.env.PI_SCOUT_CATALOG);
            if (data.length > 1024 * 1024) throw scoutFailure('CATALOG_INVALID');
            const catalog = JSON.parse(data.toString('utf8'));
            if (catalog.version !== 1) throw scoutFailure('CATALOG_INVALID');
            sources = validateSources(catalog.sources);
          } catch { throw scoutFailure('CATALOG_INVALID'); }
        }
        const request = createRequest({ ...args, mode: configuration.PI_SCOUT_WORKER_MODE ?? 'public', sources, model: selectedModel,
          thinkingLevel: thinking });
        requestId = request.requestId;
        const { image, mode, dockerPath, dockerArgs } = await prepareWorker({ env: configuration, signal,
          onProgress: ({ stage }: { stage: string }) => update?.({ content: [{ type: 'text', text: stage === 'building'
            ? 'Scout: preparing the research worker for first use. This can take a few minutes.' : `Scout: ${stage}` }], details: { stage } }),
        });
        phase = 'research';
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
            // The host runner records any reported usage before classifying an
            // error/aborted response, so failed research does not erase its usage.
            if (message.stopReason === 'error' || message.stopReason === 'aborted') {
              throw Object.assign(scoutFailure('MODEL_REQUEST_FAILED'), { reportedUsage: message.usage });
            }
            return message;
          },
        });
        let saved;
        try { saved = await briefs.save(owner.sessionId, completed.result.brief); }
        catch { throw Object.assign(scoutFailure('BRIEF_STORAGE_FAILED'), { runtime: completed.runtime }); }
        // Preserve the pre-append destination/owner fence, then recheck after optional indexing.
        await destinationIdentity(ctx);
        if (!owner.current()) return { content: [{ type: 'text', text: 'Scout retained a research record for the previous session branch under its original owner; output is withheld from the new branch.' }],
          details: { outputWithheld: true, reason: 'owner-changed', cleanup: completed.runtime.cleanup } };
        const incomplete = completed.result.status === 'incomplete';
        const retained = { requestId: request.requestId,
          reference: saved.reference, destination, image, mode,
          savedAt: new Date().toISOString(),
          ...(completed.result.issue ? { researchIssue: completed.result.issue } : {}),
          researchStatus: incomplete ? 'incomplete' : (completed.result.status === 'complete' ? 'complete' : 'unknown') };
        pi.appendEntry('scout-worker-brief-v2', retained);
        const indexed = workspace && await rememberWorkspaceBrief(briefs.root, workspace, { ...retained, kind: 'worker' }, { authorize: owner.current });
        if (!owner.current()) return { content: [{ type: 'text', text: 'Scout retained a research record for the previous session branch under its original owner; output is withheld from the new branch.' }],
          details: { outputWithheld: true, reason: 'owner-changed', cleanup: completed.runtime.cleanup } };
        const currentDestination = await destinationIdentity(ctx);
        if (!owner.current()) return { content: [{ type: 'text', text: 'Scout retained a research record for the previous session branch under its original owner; output is withheld from the new branch.' }],
          details: { outputWithheld: true, reason: 'owner-changed', cleanup: completed.runtime.cleanup } };
        observe(ctx, incomplete ? 'observed' : 'settled', [incomplete
          ? 'Partial findings saved; gaps remain. Worker cleanup confirmed. No human decision is requested by this record.'
          : 'Worker cleanup confirmed; brief retained.', ...(indexed ? [] : ['Workspace inventory is incomplete; the saved branch reference remains usable.'])]);
        if (JSON.stringify(currentDestination) !== JSON.stringify(destination)) {
          return { ...(incomplete ? { isError: true } : {}), content: [{ type: 'text', text: 'Scout saved its research record, but the model destination changed. Retrieve the exact reference only after authorizing the new destination.' }],
            details: { briefReference: saved.reference, outputWithheld: true, cleanup: completed.runtime.cleanup,
              semanticApproval: false, protectedOnline: false } };
        }
        const brief = completed.result.brief;
        const short = (value: string) => value.length > 300 ? `${value.slice(0, 299)}…` : value;
        const partialAnswer = incomplete ? [
          'Scout research is incomplete. A research record was saved; this is not task completion.',
          ...(completed.result.issue === 'BRIEF_UPDATE_REJECTED' ? ['The final brief update was not saved. This reference retains the previous validated draft unchanged; it does not include the rejected update.'] : []),
          `Evidence-cited findings: ${brief.findings.filter((finding: any) => finding.status !== 'unverified').length}; unverified findings: ${brief.findings.filter((finding: any) => finding.status === 'unverified').length}. Citation validation is not independent approval.`,
          ...brief.findings.slice(0, 3).map((finding: any) => `- ${finding.status}: ${short(finding.claim)}`),
          ...brief.gaps.slice(0, 3).map((gap: string) => `Gap: ${short(gap)}`),
          'Next: read the saved brief for the full evidence and gaps. Use only what supports the task; address the missing evidence before claiming research complete. Do not repeat completed retrievals automatically.',
        ].join('\n') : undefined;
        const details = { ...completed, ...(incomplete ? { result: { ...completed.result, answer: partialAnswer }, partialAvailable: true } : {}),
          researchStatus: completed.result.status ?? 'unknown', briefPath: saved.path, briefSha256: saved.sha256,
          briefReference: saved.reference,
          semanticApproval: false, protectedOnline: false };
        const modelUsage = usageText(completed.runtime.usage);
        return { ...(incomplete ? { isError: true } : {}), content: [{ type: 'text', text: `${partialAnswer ?? completed.result.answer}\n\nScout brief saved: ${saved.path}\nScout worker cleanup: confirmed.${modelUsage ? `\n${modelUsage}` : ''}` }], details };
      } catch (error) {
        if (error?.code === 'SETUP_UNSETTLED' || error?.runtime && (error.runtime.cleanup?.confirmed !== true || error.runtime.modelCallbackSettled === false)) {
          cleanupBlocked = true;
        }
        if (!owner.current()) return { isError: true, content: [{ type: 'text', text: 'Scout failed for the previous session branch. Its diagnostic is withheld from the new branch.' }], details: { outputWithheld: true, reason: 'owner-changed' } };
        const failure = failureReceipt(error, { requestId, phase, cleanupBlocked });
        let retained = false;
        try { pi.appendEntry('scout-worker-failure-v1', failure); retained = true; }
        catch { /* A session-write error must not hide the original failure. */ }
        observe(ctx, cleanupBlocked ? 'unknown' : 'failed', [failure.summary, failure.nextStep]);
        return { isError: true, content: [{ type: 'text', text: `${failureText(failure)}\nFailure record: ${retained ? 'saved in this Pi session' : 'not saved; retain this tool result'}.` }], details: { failure, retained } };
      } finally { busy = false; if (owner.current()) observe.sync(); }
    },
  });
  pi.on('context', async (event, ctx) =>
    placeReferenceNotice(event.messages, ctx.sessionManager.getBranch(), 'worker'));
}

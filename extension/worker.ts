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
import { braveDiscovery, braveOrder } from '../lib/brave-discovery.mjs';
import { prepareWorker } from '../lib/worker-setup.mjs';
import { scoutFailure, failureReceipt, failureText } from '../lib/worker-failure.mjs';
import { usageText } from '../lib/worker-usage.mjs';
import { scoutStatus } from './status.ts';
import { bindTaskDispatch, finishTaskDispatch, type CleanupState, type DispatchReceipt } from './task-dispatch.ts';
import { bindTaskHistory } from './task-history.ts';
import { scoutOwner } from './owner.ts';
import { workspaceIdentity, rememberWorkspaceBrief } from '../lib/workspace-briefs.mjs';
import { chooseResearchModel } from '../lib/research-model.mjs';
import { loadEcosystemConfig } from '../lib/ecosystem-config.mjs';
import { fetchPublicOfficialPages } from '../lib/direct-fetch.mjs';

export default function scoutWorker(pi: ExtensionAPI) {
  pi.events.on('scout:model-settings:v1', (probe: any) => probe?.report?.());
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
    exposure: 'deferred' as const,
    description: 'Research a public question in a separate Docker worker and return a sourced brief. Supply known HTTPS URLs in sourceUrls to fetch them directly in parallel. Send only public question, scope and URLs, never private code or secrets.',
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 4000 }),
      scope: Type.String({ minLength: 1, maxLength: 4000 }),
      sourceUrls: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 6, uniqueItems: true,
        description: 'Known exact public HTTPS source URLs; no credentials or fragments. Public mode only. These are retrieval targets, not proof of official ownership or evidence already checked.' })),
    }, { additionalProperties: false }),
    async execute(_id, args, signal, update, ctx) {
      if (cleanupBlocked) throw new Error('An earlier Scout setup, worker or model request did not settle. Inspect Docker and the recorded cleanup status before starting another Scout session.');
      if (busy) throw new Error('A Scout worker is already running in this Pi session');
      const ecoCfg = loadEcosystemConfig(process.env);
      const owner = captureOwner(ctx);
      const { model: selectedModel, thinking } = await chooseResearchModel(ctx, pi.getThinkingLevel(), ecoCfg, process.env);
      signal?.throwIfAborted();
      if (!owner.current()) throw Error('Session changed during Scout model selection.');
      if (busy || cleanupBlocked) throw Error('Another Scout worker owns this session. Check its status before retrying.');
      const effectiveCtx = selectedModel === ctx.model ? ctx : { ...ctx, model: selectedModel };
      const record = bindTaskHistory(pi.events, 'scout', ctx);
      const admit = bindTaskDispatch(pi.events, 'scout', ctx);
      let reservation: DispatchReceipt | undefined;
      let cleanup: CleanupState = 'not-started';
      let requestId: string | undefined;
      let phase = 'setup';
      busy = true;
      try {
        await record(_id, 'worker-brief', 'observed', 'Research worker requested.');
        signal?.throwIfAborted();
        if (!owner.current()) throw Error('Session changed before worker setup.');
        const workspace = await workspaceIdentity(ctx.cwd).catch(() => undefined);
        observe(ctx, 'running', ['Preparing isolated research worker.']);
        const destination = await destinationIdentity(ctx);
        const researchDestination = selectedModel === ctx.model ? destination : await destinationIdentity(effectiveCtx);
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
        if (admit) {
          try { reservation = await admit({ operationId: _id }); }
          catch {
            await record(_id, 'worker-brief', 'refused', 'Task controller refused the research request before worker setup.');
            return { isError: true, content: [{ type: 'text', text: 'The task controller declined this research request. Inspect the current task, existing attempt and remaining allowance in pi-daddy.' }],
              details: { phase: 'task-admission', workerStarted: false } };
          }
          signal = signal ? AbortSignal.any([signal, reservation.signal]) : reservation.signal;
        }
        signal?.throwIfAborted();
        if (!owner.current()) throw Error('Session changed before worker setup.');
        cleanup = 'unknown';
        const directAllowed = (ecoCfg?.scout?.directUrls ?? (process.env.PI_SCOUT_DIRECT_URLS === '1')) === true;
        let workerPrep;
        try {
          workerPrep = await prepareWorker({ env: configuration, signal,
            onProgress: ({ stage }: { stage: string }) => update?.({ content: [{ type: 'text', text: stage === 'building'
              ? 'Scout: preparing the research worker for first use. This can take a few minutes.' : `Scout: ${stage}` }], details: { stage } }),
          });
        } catch (setupErr: any) {
          if (
            directAllowed &&
            Array.isArray(args.sourceUrls) &&
            args.sourceUrls.length > 0 &&
            (configuration.PI_SCOUT_WORKER_MODE ?? 'public') === 'public' &&
            ['DOCKER_MISSING', 'DOCKER_UNAVAILABLE'].includes(setupErr?.code)
          ) {
            cleanup = 'not-started';
            phase = 'research';
            const pages = await fetchPublicOfficialPages({
              question: args.question,
              scope: args.scope,
              sourceUrls: args.sourceUrls,
              signal,
            });
            if (signal?.aborted) throw scoutFailure('CANCELLED');
            if (!pages.some(p => p.passages?.some(w => w.text.trim()))) throw scoutFailure('SOURCE_FETCH_FAILED');
            const excerptBlocks = pages.map((p: any, i: number) =>
              p.error
                ? `Source ${i + 1} (${p.url}): FAILED (${p.error})`
                : `Source ${i + 1} (${p.url}):\n${p.passages.map((w: any) => w.text.slice(0, 2000)).join('\n---\n')}`,
            ).join('\n\n');
            const context = {
              messages: [{
                role: 'user',
                content: [{
                  type: 'text',
                  text: `Answer the question concisely using ONLY these fetched official doc excerpts. Cite URLs and list any gaps.\nQuestion: ${args.question}\nScope: ${args.scope}\n\n${excerptBlocks.slice(0, 24000)}`,
                }],
                timestamp: Date.now(),
              }],
            };
            let msg;
            try {
              msg = await ctx.modelRegistry.streamSimple(selectedModel, context as any,
                { signal, ...(thinking === 'off' ? {} : { reasoning: thinking }) }).result();
            } catch {
              throw scoutFailure(signal?.aborted ? 'CANCELLED' : 'MODEL_REQUEST_FAILED');
            }
            if (signal?.aborted) throw scoutFailure('CANCELLED');
            if (msg?.stopReason === 'error' || msg?.stopReason === 'aborted') throw scoutFailure('MODEL_REQUEST_FAILED');
            if (!msg || !Array.isArray(msg.content)) throw scoutFailure('MODEL_RESPONSE_INVALID');
            if (msg.stopReason !== 'stop') throw scoutFailure('MODEL_INCOMPLETE');
            const answerText = msg.content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n').trim();
            if (!answerText) throw scoutFailure('ANSWER_MISSING');
            observe(ctx, 'settled', ['Direct HTTPS official-docs fetch completed (Docker unavailable).']);
            return {
              content: [{ type: 'text', text: `[Scout Direct HTTPS Mode - Docker unavailable]\n\n${answerText}` }],
              details: { mode: 'direct-urls', pages: pages.map((p: any) => ({ url: p.url, ok: !p.error, error: p.error })) },
            };
          }
          throw setupErr;
        }
        const { image, mode, dockerPath, dockerArgs } = workerPrep;
        phase = 'research';
        const completed = await runScout({ request, image, signal,
          dockerPath, dockerArgs,
          discoveryOrder: braveOrder(process.env),
          onDiscoveryFallback: destination && researchDestination && braveDiscovery(request, { env: process.env,
            authorized: async () => owner.current() &&
              JSON.stringify(await destinationIdentity(effectiveCtx)) === JSON.stringify(researchDestination) &&
              JSON.stringify(await destinationIdentity(ctx)) === JSON.stringify(destination) && owner.current() }),
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
        cleanup = completed.runtime.cleanup?.confirmed === true && completed.runtime.modelCallbackSettled !== false && completed.runtime.discoveryCallbackSettled !== false
          ? 'settled' : 'unknown';
        let saved;
        try { saved = await briefs.save(owner.sessionId, completed.result.brief); }
        catch { throw Object.assign(scoutFailure('BRIEF_STORAGE_FAILED'), { runtime: completed.runtime }); }
        const incomplete = completed.result.status === 'incomplete';
        record(_id, 'worker-brief', incomplete ? 'partial' : completed.result.status === 'complete' ? 'recorded' : 'unconfirmed',
          `Worker research brief saved with ${completed.result.brief.findings.length} findings and ${completed.result.brief.gaps.length} gaps.`, { type: 'brief', id: saved.reference.sha256 });
        // Preserve the pre-append destination/owner fence, then recheck after optional indexing.
        await destinationIdentity(ctx);
        if (!owner.current()) return { content: [{ type: 'text', text: 'Scout retained a research record for the previous session branch under its original owner; output is withheld from the new branch.' }],
          details: { outputWithheld: true, reason: 'owner-changed', cleanup: completed.runtime.cleanup } };
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
        if (error?.runtime?.cleanup?.confirmed === true && error.runtime.modelCallbackSettled !== false && error.runtime.discoveryCallbackSettled !== false) cleanup = 'settled';
        if (error?.code === 'SETUP_UNSETTLED' || error?.runtime && (error.runtime.cleanup?.confirmed !== true || error.runtime.modelCallbackSettled === false || error.runtime.discoveryCallbackSettled === false)) {
          cleanupBlocked = true;
        }
        const failure = failureReceipt(error, { requestId, phase, cleanupBlocked });
        if (failure.workerStarted === false) cleanup = 'not-started';
        // Failure receipts stay native to Scout. The shared view receives bounded status only.
        record(_id, 'worker-brief', cleanupBlocked ? 'unconfirmed' : 'failed',
          cleanupBlocked ? 'Worker research failed with cleanup unconfirmed.' : 'Worker research did not deliver a brief.');
        if (!owner.current()) return { isError: true, content: [{ type: 'text', text: 'Scout failed for the previous session branch. Its diagnostic is withheld from the new branch.' }], details: { outputWithheld: true, reason: 'owner-changed' } };
        let retained = false;
        try { pi.appendEntry('scout-worker-failure-v1', failure); retained = true; }
        catch { /* A session-write error must not hide the original failure. */ }
        observe(ctx, cleanupBlocked ? 'unknown' : 'failed', [failure.summary, failure.nextStep]);
        return { isError: true, content: [{ type: 'text', text: `${failureText(failure)}\nFailure record: ${retained ? 'saved in this Pi session' : 'not saved; retain this tool result'}.` }], details: { failure, retained } };
      } finally {
        try { await finishTaskDispatch(reservation, cleanup); }
        finally { busy = false; if (owner.current()) observe.sync(); }
      }
    },
  });
  pi.on('context', async (event, ctx) =>
    placeReferenceNotice(event.messages, ctx.sessionManager.getBranch(), 'worker'));
}

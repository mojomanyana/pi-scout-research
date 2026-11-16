import { referenceNotice, validateReference } from './brief-reference.mjs';

// Parent extensions only; not a Docker worker input. The entry types repeat referenceNotice's selection
// because brief-reference.mjs is part of the worker image identity and is deliberately left unchanged.
const KINDS = {
  worker: { customType: 'scout-worker-context', entryTypes: ['scout-worker-brief-v1', 'scout-worker-brief-v2'],
    toolName: 'scout_research', field: 'briefReference' },
  local: { customType: 'scout-brief-context', entryTypes: ['scout-brief-v1', 'scout-brief-v2'],
    toolName: 'research_brief', field: 'reference' },
};
const LEADING = ['compactionSummary', 'branchSummary', 'system', 'toolResult'];

// Give the saved-reference notice the same position on every request while its reference is unchanged.
// Pi sends it as a user message; re-appended after the newest message it changed the request prefix on
// every turn, which provider prompt caching of earlier conversation depends on. Position grants no access.
export function placeReferenceNotice(messages, entries, kind, timestamp) {
  const { customType, entryTypes, toolName, field } = kind === 'worker' ? KINDS.worker : KINDS.local;
  const notice = referenceNotice(entries, kind);
  const kept = messages.filter(message => !(message.role === 'custom' && message.customType === customType));
  if (!notice) return kept.length === messages.length ? undefined : { messages: kept };
  let sha256;
  try { sha256 = validateReference(entries.findLast(item => item.type === 'custom' && entryTypes.includes(item.customType)).data.reference).sha256; }
  catch { /* Legacy notice: no exact reference to locate. */ }
  // Prefer the newest result of the tool that returned this reference; otherwise lead, after summaries.
  const origin = sha256 === undefined ? -1 : kept.findLastIndex(message => message.role === 'toolResult' &&
    message.toolName === toolName && message.details?.[field]?.sha256 === sha256);
  // Tool results of one assistant turn stay adjacent: a user message between them orphans the later ones.
  const skipped = origin < 0 ? LEADING : ['toolResult'];
  let index = origin + 1;
  while (index < kept.length && skipped.includes(kept[index].role)) index++;
  kept.splice(index, 0, { role: 'custom', customType, content: notice, display: false, timestamp });
  return { messages: kept };
}

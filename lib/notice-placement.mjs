import { referenceNotice } from './brief-reference.mjs';

// Parent extensions only; not a Docker worker input. brief-reference.mjs is part of the worker image
// identity and is deliberately left unchanged.
const KINDS = {
  worker: { customType: 'scout-worker-context', toolName: 'scout_research', field: 'briefReference' },
  local: { customType: 'scout-brief-context', toolName: 'research_brief', field: 'reference' },
};
const LEADING = ['compactionSummary', 'branchSummary', 'system', 'toolResult'];

// Give the saved-reference notice the same position on every request while its reference is unchanged.
// Pi sends it as a user message; re-appended after the newest message it changed the request prefix on
// every turn, which provider prompt caching of earlier conversation depends on. Position grants no access.
export function placeReferenceNotice(messages, entries, kind) {
  const { customType, toolName, field } = kind === 'worker' ? KINDS.worker : KINDS.local;
  const notice = referenceNotice(entries, kind);
  const kept = messages.filter(message => !(message.role === 'custom' && message.customType === customType));
  if (!notice) return kept.length === messages.length ? undefined : { messages: kept };
  // The notice ends with the validated reference it cites, so placement follows exactly that reference.
  let sha256;
  try { sha256 = JSON.parse(notice.slice(notice.lastIndexOf('\n') + 1)).sha256; }
  catch { /* Legacy notice: it cites no reference to locate. */ }
  // Prefer the newest result of the tool that returned this reference; otherwise lead, after summaries.
  const origin = sha256 === undefined ? -1 : kept.findLastIndex(message => message.role === 'toolResult' &&
    message.toolName === toolName && message.details?.[field]?.sha256 === sha256);
  // Tool results of one assistant turn stay adjacent: a user message between them orphans the later ones.
  const skipped = origin < 0 ? LEADING : ['toolResult'];
  let index = origin + 1;
  while (index < kept.length && skipped.includes(kept[index].role)) index++;
  // The neighbour's timestamp, not the clock: the inserted message is then identical on every request.
  kept.splice(index, 0, { role: 'custom', customType, content: notice, display: false, timestamp: kept[index - 1]?.timestamp ?? 0 });
  return { messages: kept };
}

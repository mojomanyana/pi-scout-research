import { branchReferences, readBriefReference, referenceKey } from './brief-reference.mjs';
import { workspaceIdentity, workspaceCurrent, readWorkspaceBriefs } from './workspace-briefs.mjs';

const short = (value, limit) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').slice(0, limit) : '';
const belongs = (item, kind) => item.kind ? item.kind === kind : kind === 'worker' ? typeof item.requestId === 'string' : typeof item.requestId !== 'string';
const branch = ctx => branchReferences(ctx.sessionManager.getBranch().slice(-200));

/** Human terminal display only. This is not a model-context or peer disclosure grant. */
export async function researchInventory({ root, ctx, kind, signal, current = () => true }) {
  const live = () => !signal?.aborted && current();
  if (!live()) return undefined;
  let workspace;
  try { workspace = await workspaceIdentity(ctx.cwd); }
  catch { return { scope: 'This workspace', state: 'unavailable', summary: 'This workspace cannot be read right now.', limited: true, entries: [] }; }
  const index = await readWorkspaceBriefs(root, workspace);
  const branchItems = branch(ctx).filter(item => belongs(item, kind));
  const indexed = index.records.filter(item => belongs(item, kind));
  const records = new Map([...indexed, ...branchItems].map(item => [referenceKey(item.reference), item]));
  const scope = index.state === 'available' ? 'This workspace' : 'This session only';
  if (!records.size) return live() ? { scope, state: index.state === 'unavailable' ? 'unavailable' : 'unknown',
    summary: index.state === 'available' ? 'No saved research of this kind is listed here. Older research may still exist.'
      : 'Workspace research history is not available in this view. Older research may still exist.', limited: true, entries: [] } : undefined;
  const entries = [];
  for (const [key, item] of [...records].reverse().slice(0, 6)) {
    const authorize = async reference => {
      if (!live() || !await workspaceCurrent(workspace) || key !== referenceKey(reference)) return false;
      if (branch(ctx).some(value => belongs(value, kind) && referenceKey(value.reference) === key)) return live();
      const fresh = await readWorkspaceBriefs(root, workspace);
      return live() && fresh.state === 'available' && fresh.records.some(value => belongs(value, kind) && referenceKey(value.reference) === key);
    };
    const read = await readBriefReference(root, item.reference, { maxBytes: 24000, authorize });
    if (!live()) return undefined;
    let brief;
    try {
      if (read.ok && read.complete) {
        const parsed = JSON.parse(read.excerpt);
        if (typeof parsed.question === 'string' && Array.isArray(parsed.findings) && parsed.findings.length <= 20 &&
            Array.isArray(parsed.gaps) && parsed.gaps.length <= 12) brief = parsed;
      }
    } catch { /* Invalid or legacy oversized evidence has no preview. */ }
    const details = [`Saved: ${short(item.savedAt, 40).replace('T', ' ').replace('.000Z', ' UTC') || 'time not recorded'}.`,
      'Saved observations; sources may need rechecking.'];
    if (!brief) {
      entries.push({ id: key, title: 'Saved research unavailable', summary: `The saved preview ${read.ok ? 'cannot be displayed within this view' : `is ${short(read.status, 40)}`}.`, details, reference: JSON.stringify(item.reference) });
      continue;
    }
    const cited = brief.findings.filter(value => ['supported', 'conflicting'].includes(value?.status)).length;
    const sources = new Set(brief.findings.flatMap(value => Array.isArray(value?.citations) ? value.citations.map(citation => citation?.sourceId).filter(Boolean) : []));
    const coverage = item.researchStatus === 'complete' ? 'Reported complete' : item.researchStatus === 'incomplete' ? 'Partial' : 'Coverage not recorded';
    const finding = brief.findings.find(value => value?.status === 'supported') ?? brief.findings[0];
    if (finding) details.push(`${finding.status === 'supported' ? 'Sourced finding' : finding.status === 'conflicting' ? 'Conflicting finding' : 'Unverified finding'}: ${short(finding.claim, 300)}`);
    if (brief.gaps.length) details.push(`Gap: ${short(brief.gaps[0], 300)}`);
    if (item.researchIssue === 'BRIEF_UPDATE_REJECTED') details.push('Last update was not saved; showing the previous draft.');
    entries.push({ id: key, title: short(brief.question, 150) || 'Saved research',
      summary: `${coverage} · ${cited} sourced findings · ${brief.findings.length - cited} unverified · ${sources.size} sources · ${brief.gaps.length} gaps`,
      details, reference: JSON.stringify(item.reference) });
  }
  if (!live() || !await workspaceCurrent(workspace)) return undefined;
  // A later entry's read may yield while an earlier reference is revoked.
  const finalIndex = await readWorkspaceBriefs(root, workspace);
  const finalRecords = new Map([...finalIndex.records.filter(item => belongs(item, kind)), ...branch(ctx).filter(item => belongs(item, kind))]
    .map(item => [referenceKey(item.reference), item]));
  if (!live() || !await workspaceCurrent(workspace)) return undefined;
  if (!finalRecords.size) return { scope, state: finalIndex.state === 'unavailable' ? 'unavailable' : 'unknown',
    summary: 'These saved records are no longer available in this view. Older research may still exist.', limited: true, entries: [] };
  const checkedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const inventory = { scope: finalIndex.state === 'available' ? 'This workspace' : 'This session only', state: 'available',
    summary: `${finalRecords.size} saved research records · recent topics. Older research may not be listed. Checked ${checkedAt} UTC.`,
    count: finalRecords.size, limited: true, entries: entries.filter(entry => finalRecords.has(entry.id)) };
  while (Buffer.byteLength(JSON.stringify(inventory)) > 8192 && inventory.entries.length) inventory.entries.pop();
  return inventory;
}

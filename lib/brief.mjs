import { mkdir, open, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { boundedText, digest } from './catalog.mjs';
import { MAX_BRIEF_BYTES, briefReference, readBriefReference } from './brief-reference.mjs';

export function validateBrief(input, catalog) {
  const strings = (value, name) => {
    if (!Array.isArray(value) || value.length > 12) throw new Error(`${name} must contain at most 12 entries`);
    return value.map(item => boundedText(item, name, 1200));
  };
  if (!Array.isArray(input.findings) || input.findings.length > 20) throw new Error('At most 20 findings per brief');
  const findings = input.findings.map(finding => {
    if (!['supported', 'conflicting', 'unverified'].includes(finding.status)) throw new Error('Invalid finding status');
    if (!Array.isArray(finding.citations) || finding.citations.length > 4) throw new Error('At most 4 citations per finding');
    if (finding.status !== 'unverified' && finding.citations.length === 0) throw new Error('Evidence is required');
    return {
      claim: boundedText(finding.claim, 'claim', 1600), status: finding.status,
      reason: boundedText(finding.reason, 'reason', 1200),
      citations: finding.citations.map(citation => catalog.citation(citation)),
    };
  });
  const brief = {
    version: 1, question: boundedText(input.question, 'question'), scope: boundedText(input.scope, 'scope'),
    questions: strings(input.questions, 'questions'), doneWhen: boundedText(input.doneWhen, 'doneWhen'),
    findings, gaps: strings(input.gaps, 'gaps'),
  };
  if (Buffer.byteLength(JSON.stringify(brief) + '\n', 'utf8') > MAX_BRIEF_BYTES) throw new Error('Brief exceeds 24000 UTF-8 bytes; summarize it');
  return brief;
}

export class BriefStore {
  constructor(root) { this.root = root; }
  async save(sessionId, brief) {
    boundedText(sessionId, 'session identity', 200);
    const directory = join(this.root, digest(sessionId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Brief directory must be a real directory');
    const bytes = JSON.stringify(brief) + '\n';
    if (Buffer.byteLength(bytes, 'utf8') > MAX_BRIEF_BYTES) throw new Error('Brief exceeds 24000 UTF-8 bytes; summarize it');
    const sha256 = digest(bytes);
    const reference = briefReference(sessionId, sha256, Buffer.byteLength(bytes, 'utf8'));
    const path = join(directory, `${sha256}.json`);
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
      await handle.writeFile(bytes, 'utf8');
      await handle.sync();
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readBriefReference(this.root, reference, { maxBytes: MAX_BRIEF_BYTES, authorize: async () => true });
      if (!existing.ok || !existing.complete || existing.excerpt !== bytes) {
        throw new Error('Existing brief does not match its identity');
      }
    } finally { await handle?.close(); }
    return { path, sha256, reference };
  }
}

// Pi's active branch is authoritative, never the newest file in the storage directory.
export function branchBrief(entries) {
  return entries.findLast(entry => entry.type === 'custom' && entry.customType === 'scout-brief-v1')?.data;
}

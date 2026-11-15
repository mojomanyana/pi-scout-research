import { mkdir, open, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { boundedText, digest } from './catalog.mjs';
import { MAX_BRIEF_BYTES, briefReference, readBriefReference } from './brief-reference.mjs';
import { briefValidation, briefCorrection } from './brief-validation.mjs';

export function validateBrief(input, catalog) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw briefValidation('BRIEF_OBJECT');
  const text = (value, field, limit = 4000) => {
    if (typeof value !== 'string' || !value.trim() || value.length > limit) throw briefValidation(`TEXT_${limit}`, field);
    return value;
  };
  const strings = (value, name) => {
    if (!Array.isArray(value) || value.length > 12) throw briefValidation('LIST_12', name);
    return value.map((item, index) => text(item, `${name}[${index}]`, 1200));
  };
  if (!Array.isArray(input.findings) || input.findings.length > 20) throw briefValidation('FINDINGS_20', 'findings');
  const findings = input.findings.map((finding, index) => {
    const field = `findings[${index}]`;
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) throw briefValidation('FINDING_OBJECT', field);
    if (!['supported', 'conflicting', 'unverified'].includes(finding.status)) throw briefValidation('FINDING_STATUS', `${field}.status`);
    if (!Array.isArray(finding.citations) || finding.citations.length > 4) throw briefValidation('CITATIONS_4', `${field}.citations`);
    if (finding.status !== 'unverified' && finding.citations.length === 0) throw briefValidation('CITATION_REQUIRED', `${field}.citations`);
    return {
      claim: text(finding.claim, `${field}.claim`, 1600), status: finding.status,
      reason: text(finding.reason, `${field}.reason`, 1200),
      citations: finding.citations.map((citation, citationIndex) => {
        try { return catalog.citation(citation); }
        catch (error) {
          const correction = briefCorrection(error);
          if (!correction) throw error;
          const citationField = `${field}.citations[${citationIndex}]`;
          throw briefValidation(correction.code, correction.field === 'brief' ? citationField : `${citationField}.${correction.field}`);
        }
      }),
    };
  });
  const brief = {
    version: 1, question: text(input.question, 'question'), scope: text(input.scope, 'scope'),
    questions: strings(input.questions, 'questions'), doneWhen: text(input.doneWhen, 'doneWhen'),
    findings, gaps: strings(input.gaps, 'gaps'),
  };
  if (Buffer.byteLength(JSON.stringify(brief) + '\n', 'utf8') > MAX_BRIEF_BYTES) throw briefValidation('BRIEF_BYTES');
  return brief;
}

// This records coverage gaps, not semantic approval of the cited conclusions.
export function briefOutcome(brief) {
  return !brief.findings.length || brief.gaps.length || brief.findings.some(finding => finding.status === 'unverified')
    ? 'incomplete' : 'complete';
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
    if (Buffer.byteLength(bytes, 'utf8') > MAX_BRIEF_BYTES) throw briefValidation('BRIEF_BYTES');
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { Catalog, digest } from '../lib/catalog.mjs';
import { validateBrief, briefOutcome } from '../lib/brief.mjs';
import { briefValidation, briefCorrection } from '../lib/brief-validation.mjs';

const sourceText = 'Use a visible label for each input.\n' + Array.from({ length: 26 }, (_, index) => `word${index}`).join(' ');
const source = { id: 'forms', title: 'Form guidance', locator: 'fixture:forms',
  retrievedAt: '2026-11-15T00:00:00Z', text: sourceText, sha256: digest(sourceText) };
const catalog = new Catalog({ version: 1, sources: [source] });
const valid = () => ({ question: 'How should inputs be labelled?', scope: 'This supplied document only',
  questions: [], doneWhen: 'The supported guidance and any gaps are stated.', gaps: [],
  findings: [{ claim: 'Inputs need visible labels.', status: 'supported', reason: 'The source gives this instruction.',
    citations: [{ sourceId: 'forms', start: 1, end: 1, quote: 'Use a visible label for each input.' }] }] });

function correctionFor(change) {
  const brief = valid(); change(brief);
  try { validateBrief(brief, catalog); }
  catch (error) { return { correction: briefCorrection(error), error }; }
  assert.fail('Invalid brief was accepted');
}

test('citation corrections identify the field and a bounded repair without leaking submitted values', () => {
  const secret = 'token=private-source-text';
  const cases = [
    [brief => { brief.findings[0].citations[0].sourceId = secret; }, 'SOURCE_UNKNOWN', 'sourceId'],
    [brief => { brief.findings[0].citations[0].start = 0; }, 'LINE_RANGE', 'lines'],
    [brief => { delete brief.findings[0].citations[0].end; }, 'LINE_RANGE', 'lines'],
    [brief => { brief.findings[0].citations[0].start = 1; brief.findings[0].citations[0].end = 81; }, 'LINE_RANGE', 'lines'],
    [brief => { brief.findings[0].citations[0].start = 3; brief.findings[0].citations[0].end = 3; }, 'LINE_START', 'lines'],
    [brief => { brief.findings[0].citations[0].quote = secret; }, 'QUOTE_NOT_EXACT', 'quote'],
    [brief => { Object.assign(brief.findings[0].citations[0], { start: 2, end: 2, quote: sourceText.split('\n')[1] }); }, 'QUOTE_WORDS', 'quote'],
  ];
  for (const [change, code, suffix] of cases) {
    const { correction, error } = correctionFor(change);
    assert.equal(correction.code, code);
    assert.equal(correction.field, `findings[0].citations[0].${suffix}`);
    assert.ok(correction.message.length < 240);
    assert.equal(JSON.stringify(correction).includes(secret), false);
    assert.equal(error.message.includes(secret), false);
  }
  const corrected = validateBrief(valid(), catalog);
  assert.equal(corrected.findings[0].citations[0].sha256, source.sha256);
  assert.equal(corrected.findings[0].citations[0].quote, valid().findings[0].citations[0].quote);
});

test('brief corrections distinguish unsupported claims, collection limits and character limits', () => {
  const cases = [
    [brief => { brief.findings[0].citations = []; }, 'CITATION_REQUIRED', 'findings[0].citations'],
    [brief => { brief.findings[0].citations = Array(5).fill(brief.findings[0].citations[0]); }, 'CITATIONS_4', 'findings[0].citations'],
    [brief => { brief.findings[0].claim = 'x'.repeat(1601); }, 'TEXT_1600', 'findings[0].claim'],
    [brief => { brief.findings[0].reason = 'x'.repeat(1201); }, 'TEXT_1200', 'findings[0].reason'],
    [brief => { brief.findings[0].status = 'approved'; }, 'FINDING_STATUS', 'findings[0].status'],
    [brief => { brief.questions = Array(13).fill('Question'); }, 'LIST_12', 'questions'],
    [brief => { brief.gaps = ['x'.repeat(1201)]; }, 'TEXT_1200', 'gaps[0]'],
    [brief => { brief.question = ''; }, 'TEXT_4000', 'question'],
    [brief => { brief.findings = Array(21).fill(brief.findings[0]); }, 'FINDINGS_20', 'findings'],
    [brief => { brief.findings = [null]; }, 'FINDING_OBJECT', 'findings[0]'],
    [brief => { brief.findings[0].citations = [null]; }, 'CITATION_OBJECT', 'findings[0].citations[0]'],
  ];
  for (const [change, code, field] of cases) {
    const { correction } = correctionFor(change);
    assert.equal(correction.code, code);
    assert.equal(correction.field, field);
  }
  assert.throws(() => validateBrief(null, catalog), error => briefCorrection(error)?.code === 'BRIEF_OBJECT');
});

test('UTF-8 size corrections are distinct from character-limit corrections', () => {
  const { correction } = correctionFor(brief => {
    brief.question = '界'.repeat(4000); brief.scope = '界'.repeat(4000);
  });
  assert.equal(correction.code, 'BRIEF_BYTES');
  assert.equal(correction.field, 'brief');
  assert.match(correction.message, /24000 UTF-8 bytes/);
});

test('only locally created allowlisted corrections are trusted, independently of exception text', () => {
  const secret = 'Bearer private-provider-response';
  assert.equal(briefCorrection(new Error(secret)), undefined);
  assert.equal(briefCorrection({ name: 'BriefValidationError', code: 'QUOTE_WORDS', message: secret }), undefined);
  assert.equal(briefCorrection(null), undefined);
  const error = briefValidation('REQUEST_MISMATCH', 'scope');
  error.message = secret;
  const correction = briefCorrection(error);
  assert.equal(correction.field, 'scope');
  assert.equal(correction.code, 'REQUEST_MISMATCH');
  assert.equal(JSON.stringify(correction).includes(secret), false);
  assert.equal(Object.isFrozen(correction), true);
  assert.equal(briefCorrection(briefValidation(secret, secret)).field, 'brief');
  assert.equal(JSON.stringify(briefCorrection(briefValidation(secret, secret))).includes(secret), false);
});

test('saved coverage remains incomplete for empty, unverified or explicitly gapped findings', () => {
  const supported = validateBrief(valid(), catalog);
  assert.equal(briefOutcome(supported), 'complete');
  assert.equal(briefOutcome({ ...supported, gaps: ['Keyboard reordering evidence is unavailable.'] }), 'incomplete');
  assert.equal(briefOutcome({ ...supported, findings: [] }), 'incomplete');
  assert.equal(briefOutcome({ ...supported, findings: [{ claim: 'Not checked', status: 'unverified', reason: 'Source unavailable', citations: [] }] }), 'incomplete');
  const unresolved = valid(); unresolved.findings[0].status = 'unverified'; unresolved.findings[0].citations = [];
  assert.equal(validateBrief(unresolved, catalog).findings[0].status, 'unverified');
});

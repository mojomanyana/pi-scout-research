import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResearch, briefSchema } from '../worker/research.mjs';
import { createRequest, validateRequest, validateResult } from '../lib/worker-protocol.mjs';

const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', reasoning: false,
  input: ['text'], contextWindow: 32000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
// A known official URL; all responses below are synthetic and no page is fetched.
const url = 'https://www.w3.org/WAI/tutorials/forms/labels/';
const request = () => createRequest({ question: 'How should the form identify its controls?',
  scope: 'One official documentation page; no implementation or accessibility audit.',
  mode: 'public', sourceUrls: [url], model });
const draft = req => ({ question: req.question, scope: req.scope, questions: [],
  doneWhen: 'Report the supported guidance and missing evidence.', findings: [], gaps: [] });
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'scout-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const req = createRequest({ ...request(), ...overrides }), research = createResearch(req, root);
  await research.initialize();
  const invoke = (name, args, executeTool) => research.tools.find(tool => tool.name === name)
    .execute('fixture', args, undefined, undefined, { executeTool });
  return { req, research, invoke };
}
const page = { result: { structuredContent: { urls: [{ url, status: 200, content: 'Every control has a visible label.\nKeyboard order remains a separate question.' }] } } };

test('a failed discovery query does not block direct official-source fetching or force a retry', async t => {
  const { req, research, invoke } = await fixture(t);
  const calls = [];
  const executeTool = async (tool, args) => {
    calls.push({ tool, args });
    if (tool === 'web_search') throw Error('secret upstream error');
    return page;
  };
  await assert.rejects(invoke('research_search', { query: 'Official form labels' }, executeTool), { code: 'SOURCE_SEARCH_FAILED' });
  const fetched = await invoke('research_fetch', { url: req.sourceUrls[0] }, executeTool);
  assert.deepEqual(calls.map(call => call.tool), ['web_search', 'fetch_content']);
  assert.deepEqual(calls[1].args, { url, mode: 'raw', auth: false });
  const supported = { ...draft(req), findings: [{ claim: 'A control should have a visible label.',
    status: 'supported', reason: 'The retained synthetic page says so.',
    citations: [{ sourceId: fetched.details.id, start: 1, end: 1, quote: 'Every control has a visible label.' }] }] };
  await invoke('research_brief', supported);
  const done = await research.finish('The retained page supports visible labels.');
  assert.equal(done.status, 'complete');
  assert.equal(done.brief.findings[0].citations[0].locator, url);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(JSON.stringify(done), /secret upstream/);
});

test('supported findings and unresolved gaps persist together as incomplete', async t => {
  const { req, research, invoke } = await fixture(t);
  const fetched = await invoke('research_fetch', { url }, async () => page);
  const partial = { ...draft(req), gaps: ['No evidence about keyboard reordering was retrieved.'],
    findings: [{ claim: 'A control should have a visible label.', status: 'supported', reason: 'Retained page.',
      citations: [{ sourceId: fetched.details.id, start: 1, end: 1, quote: 'Every control has a visible label.' }] }] };
  assert.equal((await invoke('research_brief', partial)).details.status, 'incomplete');
  const done = await research.finish('Do not accept the missing keyboard guidance.');
  assert.equal(done.status, 'incomplete');
  assert.equal(done.brief.findings.length, 1);
  assert.deepEqual(done.brief.gaps, partial.gaps);
  const frame = { type: 'result', version: 1, requestId: req.requestId, ...done, sources: research.sources() };
  assert.equal(validateResult(frame, req).status, 'incomplete');
  assert.throws(() => validateResult({ ...frame, status: 'complete' }, req), /status does not match/);
});

test('missing brief saves sources as leads only, while a rejected final edit cannot approve older findings', async t => {
  const { req, research, invoke } = await fixture(t);
  const fetched = await invoke('research_fetch', { url }, async () => page);
  const missing = await research.finish('Invented: all checks passed.');
  assert.equal(missing.status, 'incomplete');
  assert.deepEqual(missing.brief.findings, []);
  assert.equal(research.sources().length, 1);
  assert.ok(missing.brief.gaps.some(gap => gap.includes(url)), 'Saved receipt preserves the exact source lead for later assessment');
  assert.doesNotMatch(JSON.stringify(missing), /all checks passed/);
  const supported = { ...draft(req), findings: [{ claim: 'Use visible labels.', status: 'supported', reason: 'Page.',
    citations: [{ sourceId: fetched.details.id, start: 1, end: 1, quote: 'Every control has a visible label.' }] }] };
  await invoke('research_brief', supported);
  await assert.rejects(invoke('research_brief', { ...supported, scope: 'secret wrong scope' }), error => {
    assert.equal(error.code, 'BRIEF_INVALID'); assert.equal(error.correction.field, 'scope');
    assert.doesNotMatch(error.message, /secret wrong scope/); return true;
  });
  const retained = await research.finish('Claiming the rejected update succeeded.');
  assert.equal(retained.status, 'incomplete');
  assert.equal(retained.brief.findings.length, 1);
  assert.equal(retained.issue, 'BRIEF_UPDATE_REJECTED');
  assert.deepEqual(retained.brief.gaps, supported.gaps, 'The earlier draft is not rewritten');
  const frame = { type: 'result', version: 1, requestId: req.requestId, ...retained, sources: research.sources() };
  assert.equal(validateResult(frame, req).status, 'incomplete');
  assert.throws(() => validateResult({ ...frame, status: 'complete' }, req), /status does not match/);
  assert.throws(() => validateResult({ ...frame, issue: 'invented' }, req), /Unknown research/);
  assert.doesNotMatch(retained.answer, /rejected update succeeded/);
});

test('known-source URLs are optional, bounded, normalized and unavailable in offline mode', () => {
  const req = request();
  assert.deepEqual(validateRequest(req).sourceUrls, [url]);
  const legacy = { ...req }; delete legacy.sourceUrls;
  assert.equal(Object.hasOwn(validateRequest(legacy), 'sourceUrls'), false);
  for (const sourceUrls of [[url, url], Array.from({ length: 7 }, (_, i) => `https://example.invalid/${i}`),
    ['http://example.invalid/'], ['https://user:secret@example.invalid/'], [`${url}#part`], ['not a URL'], ['x'.repeat(2001)],
    ['https://example.invalid/a\nb'], [`https://example.invalid/${'é'.repeat(400)}`]]) {
    assert.throws(() => validateRequest({ ...req, sourceUrls }));
  }
  assert.throws(() => validateRequest({ ...req, mode: 'offline' }), /require public/);
  assert.match(briefSchema.description, /24000 UTF-8/);
  assert.match(briefSchema.properties.findings.items.properties.citations.items.properties.quote.description, /25 words/);
  assert.match(briefSchema.properties.findings.items.properties.citations.items.properties.start.description, /80 lines/);
});

test('a rejected update preserves a near-limit valid draft byte for byte', async t => {
  const { req, research, invoke } = await fixture(t, { question: 'Q'.repeat(4000), scope: 'S'.repeat(4000) });
  const fetched = await invoke('research_fetch', { url }, async () => page);
  const value = { ...draft(req), doneWhen: 'D'.repeat(4000), questions: Array(12).fill('q'),
    findings: [{ claim: 'C'.repeat(1600), status: 'supported', reason: 'R'.repeat(1200),
      citations: [{ sourceId: fetched.details.id, start: 1, end: 1, quote: 'Every control has a visible label.' }] }] };
  const initial = (await invoke('research_brief', value)).details.brief;
  let spare = 23990 - Buffer.byteLength(JSON.stringify(initial) + '\n');
  for (let i = 0; i < value.questions.length && spare > 0; i++) {
    const added = Math.min(1199, spare); value.questions[i] += 'q'.repeat(added); spare -= added;
  }
  assert.equal(spare, 0);
  const before = (await invoke('research_brief', value)).details.brief;
  assert.equal(Buffer.byteLength(JSON.stringify(before) + '\n'), 23990);
  await assert.rejects(invoke('research_brief', { ...value, scope: 'Rejected scope' }));
  const after = await research.finish('An overconfident final answer.');
  assert.equal(after.status, 'incomplete');
  assert.equal(after.issue, 'BRIEF_UPDATE_REJECTED');
  assert.deepEqual(after.brief, before);
});

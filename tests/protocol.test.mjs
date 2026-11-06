import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequest, validateRequest, validateResult, parseFrame, encodeFrame } from '../lib/worker-protocol.mjs';
import { digest } from '../lib/catalog.mjs';

const source = { id: 'release', title: 'Release notes', locator: 'fixture:release',
  retrievedAt: '2026-10-30T00:00:00Z', text: 'Capacity is 12.', sha256: digest('Capacity is 12.') };
const model = { provider: 'fixture', id: 'fixture', name: 'Fixture', reasoning: true,
  input: ['text'], contextWindow: 32000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const request = () => createRequest({ question: 'What is the capacity?', scope: 'This release only', mode: 'offline', sources: [source], model, thinkingLevel: 'max' });
const completion = req => ({ type: 'result', version: 1, requestId: req.requestId, status: 'complete',
  answer: 'Capacity is 12.', sources: [source], brief: { question: req.question, scope: req.scope,
    questions: [], doneWhen: 'Capacity is evidenced.', gaps: [], findings: [{ claim: 'Capacity is 12.',
      status: 'supported', reason: 'The release notes state the capacity.',
      citations: [{ sourceId: 'release', start: 1, end: 1, quote: 'Capacity is 12.' }] }] } });

test('request carries only selected model metadata and rejects extra authority or credentials', () => {
  const req = request();
  assert.deepEqual(parseFrame(encodeFrame(req)), req);
  assert.equal(req.thinkingLevel, 'max');
  assert.deepEqual(createRequest({ ...req, model: { ...model, cost: { ...model.cost, tiers: [{ arbitrary: true }] } } }).model.cost, model.cost);
  assert.throws(() => validateRequest({ ...req, dockerArgs: ['--privileged'] }));
  assert.throws(() => validateRequest({ ...req, model: { ...model, apiKey: 'private' } }));
  assert.throws(() => validateRequest({ ...req, mode: 'protected' }));
  assert.throws(() => validateRequest({ ...req, sources: [{ ...source, text: 'Changed' }] }));
});

test('completion binds request, citations and immutable source inputs', () => {
  const req = request(), done = completion(req);
  assert.equal(validateResult(done, req).brief.findings[0].citations[0].sha256, source.sha256);
  assert.throws(() => validateResult({ ...done, requestId: 'other' }, req));
  assert.throws(() => validateResult({ ...done, brief: { ...done.brief, scope: 'other' } }, req));
  assert.throws(() => validateResult({ ...done, sources: [{ ...source, locator: 'fake:source' }] }, req));
  assert.throws(() => validateResult({ ...done, sources: [...done.sources, { ...source, id: 'invented' }] }, req));
  const invented = structuredClone(done);
  invented.brief.findings[0].citations[0].quote = 'Capacity is unlimited';
  assert.throws(() => validateResult(invented, req));
});

test('oversized protocol data is rejected before dispatch', () => {
  assert.throws(() => encodeFrame({ text: 'x'.repeat(4 * 1024 * 1024) }));
  assert.throws(() => parseFrame('x'.repeat(4 * 1024 * 1024 + 1)));
  assert.throws(() => createRequest({ ...request(), question: 'x'.repeat(4001) }));
});

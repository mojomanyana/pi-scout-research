import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createResearch } from '../worker/research.mjs';
import { suppliedModelBudget } from '../lib/supplied-passages.mjs';
import { createRequest, validateResult } from '../lib/worker-protocol.mjs';

const good = 'https://docs.example/v26.7.0/manual';
const model = { id: 'local', name: 'local', provider: 'fixture', input: ['text'], reasoning: false,
  contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
async function fixture(t, urls) {
  const root = await mkdtemp(join(tmpdir(), 'supplied-pages-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const req = createRequest({ mode: 'public', question: 'What controls checkpoint retention in v26.7.0?', scope: 'Supplied sources', sourceUrls: urls, model });
  const research = createResearch(req, root, undefined, { suppliedOnly: true });
  await research.initialize();
  const invoke = (name, args, executeTool, signal) => research.tools.find(tool => tool.name === name).execute('fixture', args, signal, undefined, { executeTool });
  const brief = findings => ({ question: req.question, scope: req.scope, doneWhen: 'Cite the retention rule', questions: [], gaps: [], findings });
  const finish = async capped => validateResult({ type: 'result', version: 1, requestId: req.requestId,
    ...await research.finish('Fixture answer', capped), sources: research.sources() }, req);
  return { invoke, brief, finish, research };
}
const response = (url, content) => ({ result: { structuredContent: { urls: [{ url, content, status: 200 }] } } });
function finding(p, quote) {
  const start = p.text.slice(0, p.text.indexOf(quote)).split('\n').length;
  return { status: 'supported', claim: quote, reason: 'The supplied passage states this rule.',
    citations: [{ sourceId: p.sourceId, start, end: start, quote }] };
}

test('long versioned manual yields an exact late passage, with a single fetch shared by concurrent callers', async t => {
  const { invoke, brief, finish, research } = await fixture(t, [good]);
  const quote = 'Checkpoint retention uses the smallest active lease.';
  const text = 'Unrelated configuration section.\n'.repeat(8600) + quote;
  let calls = 0;
  const engine = async (name, args) => {
    calls++; assert.equal(name, 'fetch_content'); assert.deepEqual(args, { url: good, mode: 'raw', auth: false });
    return response(good, text);
  };
  const reads = await Promise.all([1, 2, 3].map(() => invoke('research_supplied', {}, engine)));
  assert.equal(calls, 1);
  assert.ok(!research.tools.some(t => ['research_search','research_fetch','web_search'].includes(t.name)));
  assert.ok(reads.slice(1).every(read => read.details.alreadyRead && !read.details.pages));
  const passages = reads[0].details.pages[0].passages;
  const hit = passages.find(p => p.text.includes(quote));
  assert.ok(hit.offset > 131072);
  for (const p of passages) assert.equal(text.slice(p.offset, p.offset + p.text.length), p.text);
  await invoke('research_brief', brief([finding(hit, quote)]));
  const result = await finish(false);
  assert.equal(result.status, 'complete');
  assert.equal(result.brief.findings[0].citations[0].locator, good);
});

test('wrong version, unread page and cited disagreement keep independent supported evidence in the partial brief', async t => {
  const wrong = good.replace('26.7.0', '25.0.0'), missing = 'https://unavailable.example/manual', contrary = 'https://other.example/manual';
  const { invoke, brief, finish } = await fixture(t, [good, wrong, missing, contrary]);
  const calls = [];
  const { details } = await invoke('research_supplied', {}, async (name, {url}) => {
    calls.push(url); assert.equal(name, 'fetch_content');
    if (url === missing) throw Error('upstream private detail');
    return response(url, url === good ? 'Retention is automatic.' : 'Retention is manual.');
  });
  assert.deepEqual(calls, [good, missing, contrary]);
  const f = finding(details.pages[0].passages[0], 'Retention is automatic.');
  const conflict = { ...f, status: 'conflicting', claim: 'The two manuals disagree about retention.',
    citations: [...f.citations, ...finding(details.pages[3].passages[0], 'Retention is manual.').citations] };
  await invoke('research_brief', brief([f, conflict]));
  const result = await finish(false);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.brief.findings.length, 2);
  const gaps = result.brief.gaps.join(' ');
  for (const phrase of ['25.0.0','26.7.0','unavailable.example','disagree']) assert.ok(gaps.includes(phrase));
  assert.ok(!JSON.stringify(result).includes('upstream private detail'));
});

test('six actual model calls share the whole request budget and a stopped request retains its last cited finding', async t => {
  const { invoke, brief, finish } = await fixture(t, [good]);
  const { details } = await invoke('research_supplied', {}, async () => response(good, 'A checkpoint expires.'));
  await invoke('research_brief', brief([finding(details.pages[0].passages[0], 'A checkpoint expires.')]));
  let calls = 0;
  const bridge = suppliedModelBudget({ request: async () => ++calls });
  for (let i = 0; i < 6; i++) await bridge.request({});
  await assert.rejects(bridge.request({})); assert.equal(bridge.exhausted, true); assert.equal(calls, 6);
  const result = await finish(bridge.exhausted);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.brief.findings[0].citations[0].quote, 'A checkpoint expires.');
  assert.match(result.brief.gaps.join(' '), /model call limit/);
});

test('abort during fetch stops before the next supplied page or another model request', async t => {
  const { invoke, research } = await fixture(t, [good, 'https://next.example/']);
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(invoke('research_supplied', {}, async () => {
    calls++; controller.abort(); return response(good, 'Cancelled data');
  }, controller.signal));
  const bridge = suppliedModelBudget({ request: async () => ++calls });
  await assert.rejects(bridge.request({}, controller.signal));
  assert.equal(calls, 1); assert.deepEqual(research.sources(), []);
});

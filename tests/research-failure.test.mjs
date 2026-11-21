import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createResearch } from '../worker/research.mjs';
import { diagnostic } from '../lib/worker-failure.mjs';

const secret = 'Authorization: secret-provider-token /private/catalog.json';
const request = { mode: 'public', requestId: 'fixture-request', question: 'What is supported?', scope: 'Synthetic sources only', sources: [],
  model: { provider: 'fixture', id: 'fixture' } };
const brief = { question: request.question, scope: request.scope, questions: [], doneWhen: 'Report available evidence', findings: [], gaps: [] };
const fetched = content => ({ result: { structuredContent: { urls: [{ url: 'https://example.invalid/', status: 200, content }] } } });
const invoke = (research, name, args, executeTool = async () => { throw Error(secret); }) =>
  research.tools.find(tool => tool.name === name).execute('fixture-call', args, undefined, undefined, { executeTool });
const classified = code => error => {
  assert.equal(error.code, code);
  if (code === 'BRIEF_INVALID') assert.ok(error.message.startsWith(diagnostic(code).summary));
  else assert.equal(error.message, diagnostic(code).summary);
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(JSON.stringify(error) + error.message, /secret-provider-token|private\/catalog/);
  return true;
};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'scout-research-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const briefRoot = join(root, 'briefs');
  const research = createResearch(request, briefRoot);
  await research.initialize();
  return { root, briefRoot, research };
}

test('source failures are static, distinct and recoverable without retaining provider error text', async t => {
  const { research } = await fixture(t);
  await assert.rejects(invoke(research, 'research_fetch', { url: 'https://example.invalid/' }), classified('SOURCE_FETCH_FAILED'));
  await assert.rejects(invoke(research, 'research_search', { query: 'Fixture' }), classified('SOURCE_SEARCH_FAILED'));
  await assert.rejects(invoke(research, 'research_fetch', { url: 'https://example.invalid/' }, async () => undefined), classified('SOURCE_RESULT_INVALID'));
  await assert.rejects(invoke(research, 'research_search', { query: 'Fixture' }, async () => ({ result: { structuredContent: { queries: [null] } } })), classified('SOURCE_RESULT_INVALID'));
  await assert.rejects(invoke(research, 'research_fetch', { url: 'https://example.invalid/' }), classified('SOURCE_FETCH_FAILED'));
  assert.deepEqual(research.observedFailures(), ['SOURCE_FETCH_FAILED', 'SOURCE_SEARCH_FAILED', 'SOURCE_RESULT_INVALID']);
  const copied = research.observedFailures(); copied.push(secret);
  assert.equal(research.observedFailures().length, 3);

  const source = await invoke(research, 'research_fetch', { url: 'https://example.invalid/' }, async () => fetched('Fixture evidence.'));
  assert.equal(source.details.trusted, false);
  const saved = await invoke(research, 'research_brief', brief);
  assert.equal(saved.details.saved, true);
  assert.equal(research.hasModelBrief(), true);
  assert.equal(research.sources().length, 1);
  assert.equal(Object.hasOwn(saved.details, 'observedFailures'), false);
});

test('fetch status, locator, text and snapshot limits are classified without returning source error bodies', async t => {
  const { research } = await fixture(t);
  const cases = [
    [{ isError: true, result: { error: secret } }, 'SOURCE_FETCH_FAILED'],
    [{ result: { structuredContent: { urls: [{ error: secret }] } } }, 'SOURCE_FETCH_FAILED'],
    [{ result: { structuredContent: { urls: [{ url: 'https://example.invalid/', status: 503, content: secret }] } } }, 'SOURCE_FETCH_FAILED'],
    [{ result: { structuredContent: { urls: [{ url: 'https://other.invalid/', content: secret }] } } }, 'SOURCE_RESULT_INVALID'],
    [fetched(''), 'SOURCE_RESULT_INVALID'],
    [fetched('x'.repeat(131073)), 'SOURCE_LIMIT'],
  ];
  for (const [outcome, code] of cases) {
    await assert.rejects(invoke(research, 'research_fetch', { url: 'https://example.invalid/' }, async () => outcome), classified(code));
  }
  let calls = 0;
  await assert.rejects(invoke(research, 'research_fetch', { url: 'https://secret-provider-token:password@example.invalid/' }, async () => { calls++; }), classified('SOURCE_URLS_INVALID'));
  assert.equal(calls, 0);
  assert.deepEqual(research.sources(), []);
});

test('partial search success replaces raw provider diagnostics before source retention', async t => {
  const { research } = await fixture(t);
  const outcome = await invoke(research, 'research_search', { query: 'Fixture' }, async () => ({ result: { structuredContent: { queries: [
    { query: 'Fixture', provider: 'exa', error: secret, results: [] },
    { query: 'Fixture', provider: 'exa', results: [{ title: 'Fixture', url: 'https://example.invalid/', snippet: 'Evidence' }] },
  ] } } }));
  assert.equal(outcome.details.queries[0].error, 'Public search failed');
  assert.doesNotMatch(JSON.stringify(outcome) + JSON.stringify(research.sources()), /secret-provider-token/);
  assert.deepEqual(research.observedFailures(), []);
});

test('brief validation and storage have separate static failures and bounded observed history', async t => {
  const { briefRoot, research } = await fixture(t);
  await assert.rejects(invoke(research, 'research_brief', { ...brief, question: secret }), classified('BRIEF_INVALID'));
  assert.equal(research.hasModelBrief(), false);
  await assert.rejects(invoke(research, 'research_brief', { ...brief, findings: [{ claim: 'Unsupported', status: 'supported', reason: 'Fixture',
    citations: [{ sourceId: 'absent', start: 1, end: 1, quote: secret }] }] }), classified('BRIEF_INVALID'));
  await rm(briefRoot, { recursive: true });
  await writeFile(briefRoot, secret);
  await assert.rejects(invoke(research, 'research_brief', brief), classified('BRIEF_STORAGE_FAILED'));
  await assert.rejects(createResearch(request, briefRoot).initialize(), classified('BRIEF_STORAGE_FAILED'));
  assert.equal(research.hasModelBrief(), false);
  await assert.rejects(invoke(research, 'research_search', { query: 'Fixture' }), classified('SOURCE_SEARCH_FAILED'));
  await assert.rejects(invoke(research, 'research_fetch', { url: 'https://example.invalid/' }), classified('SOURCE_FETCH_FAILED'));
  await assert.rejects(invoke(research, 'research_fetch', { url: 'https://example.invalid/' }, async () => fetched('')), classified('SOURCE_RESULT_INVALID'));
  await assert.rejects(invoke(research, 'research_fetch', { url: 'https://example.invalid/' }, async () => fetched('x'.repeat(131073))), classified('SOURCE_LIMIT'));
  assert.equal(research.observedFailures().length, 6);
  assert.equal(new Set(research.observedFailures()).size, 6);
  assert.doesNotMatch(JSON.stringify(research.observedFailures()), /secret-provider-token/);
});

async function sessionFixture(t, scenario) {
  const { root } = await fixture(t);
  const key = `scout-session-fixture-${randomUUID()}`;
  globalThis[Symbol.for(key)] = scenario;
  t.after(() => { delete globalThis[Symbol.for(key)]; });
  await mkdir(join(root, 'worker')); await mkdir(join(root, 'research'));
  await writeFile(join(root, 'research', 'SKILL.md'), 'Synthetic offline session fixture.');
  let source = await readFile(new URL('../worker/session.mjs', import.meta.url), 'utf8');
  source = source.replaceAll("'@earendil-works/pi-coding-agent'", "'./sdk.mjs'").replaceAll("'@earendil-works/pi-ai'", "'./sdk.mjs'");
  for (const relative of ['./bridge.mjs', './research.mjs', '../lib/worker-failure.mjs', '../lib/supplied-passages.mjs']) {
    const actual = new URL(relative, new URL('../worker/session.mjs', import.meta.url)).href;
    source = source.replaceAll(`'${relative}'`, JSON.stringify(actual));
  }
  await writeFile(join(root, 'worker', 'session.mjs'), source);
  await writeFile(join(root, 'worker', 'sdk.mjs'), `
const scenario = globalThis[Symbol.for(${JSON.stringify(key)})];
export const createExtensionRuntime = () => ({});
export class DefaultResourceLoader {}
export const SettingsManager = { inMemory: value => value };
export const SessionManager = { inMemory: () => ({}) };
export const ModelRuntime = { create: async () => ({ registerProvider() {}, getModel: () => ({}) }) };
export const createAssistantMessageEventStream = () => { throw Error('Fixture must not stream a model'); };
export async function createAgentSession(options) {
  return { session: { messages: scenario.messages ?? [{role:'assistant',stopReason:'stop'}],
    bindExtensions: async () => {}, setActiveToolsByName() {},
    prompt: async () => scenario.prompt?.(options.customTools),
    getLastAssistantText: () => scenario.answer ?? 'Synthetic answer',
    getSessionStats: () => ({ tokens: {input:0,output:0,cacheRead:0,cacheWrite:0,total:0},assistantMessages:0 }),
    extensionRunner: {emit: async () => { scenario.shutdown = true; if (scenario.shutdownError) throw Error('secret-provider-token'); }},
    dispose: () => {scenario.disposed = true; if (scenario.disposeError) throw Error('secret-provider-token');}, abort: async () => {},
  } };
}
`);
  const { runResearch } = await import(pathToFileURL(join(root, 'worker', 'session.mjs')).href);
  return { root, runResearch: async (...args) => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR, previousCookies = process.env.PI_ALLOW_BROWSER_COOKIES;
    try { return await runResearch(...args); }
    finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousCookies === undefined) delete process.env.PI_ALLOW_BROWSER_COOKIES; else process.env.PI_ALLOW_BROWSER_COOKIES = previousCookies;
    }
  } };
}

test('session terminal failures keep static model/output codes and always dispose', async t => {
  const cases = [
    [{ prompt: async () => { throw Error(secret); } }, {}, 'MODEL_REQUEST_FAILED'],
    [{ messages: [] }, {}, 'MODEL_INCOMPLETE'],
    [{ messages: [{ role: 'assistant', stopReason: 'length', errorMessage: secret }] }, {}, 'MODEL_INCOMPLETE'],
    [{ messages: [{ role: 'assistant', stopReason: 'error', errorMessage: secret }] }, { failureCode: 'MODEL_RESPONSE_INVALID' }, 'MODEL_RESPONSE_INVALID'],
    [{ answer: ' ' }, {}, 'ANSWER_MISSING'],
    [{ shutdownError: true, disposeError: true }, {}, 'WORKER_FAILED'],
    [{ shutdownError: true, prompt: async tools => tools.find(tool => tool.name === 'research_brief').execute('fixture', brief) }, {}, 'WORKER_FAILED'],
    [{ disposeError: true, prompt: async tools => tools.find(tool => tool.name === 'research_brief').execute('fixture', brief) }, {}, 'WORKER_FAILED'],
  ];
  for (const [scenario, bridge, code] of cases) {
    const { root, runResearch } = await sessionFixture(t, scenario);
    await assert.rejects(runResearch({ ...request, mode: 'offline' }, bridge, { cwd: root }), classified(code));
    assert.equal(scenario.shutdown, true); assert.equal(scenario.disposed, true);
  }
});

test('normal session finish retains missing or corrected briefs as incomplete without extra calls', async t => {
  for (const recover of [false, true]) {
    const scenario = { prompt: async tools => {
      await assert.rejects(tools.find(tool => tool.name === 'research_brief').execute('fixture', { ...brief, question: secret }), classified('BRIEF_INVALID'));
      if (recover) await tools.find(tool => tool.name === 'research_brief').execute('fixture', brief);
    } };
    const { root, runResearch } = await sessionFixture(t, scenario);
    const completed = await runResearch({ ...request, mode: 'offline' }, {}, { cwd: root });
    assert.equal(completed.status, 'incomplete');
    assert.equal(Object.hasOwn(completed, 'observedFailures'), false);
    assert.deepEqual(completed.brief.findings, []);
    if (!recover) {
      assert.match(completed.brief.gaps.join(' '), /without a valid model-authored brief/);
      assert.match(completed.brief.gaps.join(' '), /question/);
      assert.doesNotMatch(JSON.stringify(completed), /secret-provider-token/);
    }
    assert.equal(scenario.shutdown, true); assert.equal(scenario.disposed, true);
  }
});

test('normal finish without a brief retains a minimal gap receipt and ignores final-answer claims', async t => {
  const scenario = { answer: 'Unsupported claim: all accessibility checks passed.' };
  const { root, runResearch } = await sessionFixture(t, scenario);
  const completed = await runResearch({ ...request, mode: 'offline' }, {}, { cwd: root });
  assert.equal(completed.status, 'incomplete');
  assert.deepEqual(completed.brief.findings, []);
  assert.match(completed.brief.gaps[0], /without a valid model-authored brief/);
  assert.doesNotMatch(completed.answer, /all accessibility checks passed/);
  assert.equal(completed.usage.modelCalls, 0, 'No fallback model call');
  assert.equal(scenario.shutdown, true); assert.equal(scenario.disposed, true);
});

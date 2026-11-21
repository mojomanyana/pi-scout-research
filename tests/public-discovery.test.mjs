import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { braveDiscovery, braveOrder, dockerEnvironment } from '../lib/brave-discovery.mjs';
import { createResearch } from '../worker/research.mjs';
import { ModelBridge } from '../worker/bridge.mjs';

const env = { PI_SCOUT_SEARCH_FALLBACK: 'brave', BRAVE_API_KEY: 'fixture-only-key' };
const request = { mode: 'public', question: 'What is the release policy?', scope: 'Fixture scope', sources: [], requestId: 'fixture' };
const signal = new AbortController().signal;
const url = 'https://docs.example/policy';
const rows = [{ title: 'Policy', url, description: 'Search snippet' }];
const json = results => Response.json({ web: { results } });

test('discovery uses the exact authorized question at the fixed origin once and returns bounded leads', async () => {
  let calls = 0, authorizations = 0;
  const search = braveDiscovery(request, { env, authorized: async () => { authorizations++; return true; },
    fetchImpl: async (endpoint, options) => {
      calls++;
      assert.equal(endpoint.origin + endpoint.pathname, 'https://api.search.brave.com/res/v1/web/search');
      assert.deepEqual(Object.fromEntries(endpoint.searchParams), { q: request.question, count: '5' });
      assert.deepEqual(options.headers, { accept: 'application/json', 'X-Subscription-Token': env.BRAVE_API_KEY });
      assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
      return json([{ url: 'file:///etc/private' }, { ...rows[0], url: url + '#section' }, ...rows, { ...rows[0], url: 'https://other.example/', title: env.BRAVE_API_KEY },
        ...Array.from({ length: 8 }, (_, index) => ({ url: url + index, title: 'T'.repeat(999), description: 'S'.repeat(999) }))]);
    } });
  const found = await search(signal);
  assert.equal(found.length, 5); assert.deepEqual(found[0], { title: 'Policy', url, snippet: 'Search snippet' });
  assert.equal(found[1].title.length, 300); assert.equal(found[1].snippet.length, 400);
  assert.ok(!JSON.stringify(found).includes(env.BRAVE_API_KEY));
  await assert.rejects(search(signal), { code: 'SOURCE_SEARCH_FAILED' });
  assert.equal(calls, 1); assert.equal(authorizations, 2);
});

test('Brave is preferred with a key; offline, known URLs, unsuitable questions and absent key withhold it', () => {
  assert.equal(braveOrder({}), 'first');
  assert.equal(braveOrder(env), 'fallback');
  assert.equal(braveOrder({ ...env, PI_SCOUT_SEARCH_PROVIDER: 'brave' }), 'first');
  assert.equal(typeof braveDiscovery(request, { env: { BRAVE_API_KEY: env.BRAVE_API_KEY } }), 'function');
  assert.deepEqual(dockerEnvironment({ BRAVE_API_KEY: env.BRAVE_API_KEY, Brave_Api_Key: 'redact', PATH: '/usr/bin' }), { PATH: '/usr/bin' });
  for (const [req, configuration] of [
    [{ ...request, mode: 'offline' }, env], [{ ...request, sourceUrls: [url] }, env],
    [{ ...request, question: 'x'.repeat(601) }, env], [{ ...request, question: 'term '.repeat(76) }, env],
    [request, { ...env, PI_SCOUT_SEARCH_PROVIDER: 'exa' }], [request, { ...env, PI_SCOUT_SEARCH_FALLBACK: 'off' }],
    [request, { PI_SCOUT_SEARCH_FALLBACK: 'brave' }],
  ]) assert.equal(braveDiscovery(req, { env: configuration }), undefined);
});

test('denial, cancellation, revocation, errors and oversized responses withhold private data', async () => {
  for (const kind of ['denied', 'cancelled', 'revoke', 'forbidden', 'too-large', 'stream-large', 'malformed', 'empty', 'timeout']) {
    let checks = 0, calls = 0;
    const controller = new AbortController();
    if (kind === 'cancelled') controller.abort();
    const run = braveDiscovery(request, { env,
      authorized: async () => ++checks === 1 ? kind !== 'denied' : kind !== 'revoke',
      fetchImpl: async () => {
        calls++;
        if (kind === 'forbidden') return new Response('private diagnostic ' + env.BRAVE_API_KEY, { status: 403 });
        if (kind === 'too-large') return new Response('small', { headers: { 'content-length': '999999' } });
        if (kind === 'stream-large') return new Response(new Uint8Array(128 * 1024 + 1));
        if (kind === 'malformed') return new Response('private diagnostic');
        if (kind === 'empty') return json([]);
        if (kind === 'timeout') throw new DOMException('private diagnostic', 'TimeoutError');
        return json(rows);
      } });
    await assert.rejects(run(controller.signal), error => error.code === 'SOURCE_SEARCH_FAILED' &&
      !/fixture-only-key|private diagnostic|release policy/i.test(error.message), kind);
    assert.equal(calls, ['denied', 'cancelled'].includes(kind) ? 0 : 1, kind);
  }
});

test('failed or empty Exa discovery can lead to a supported original passage, never a supported snippet', async t => {
  const root = await mkdtemp(join(tmpdir(), 'scout-fallback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const kind of ['failure', 'empty', 'success', 'old-host', 'both-fail', 'brave-first', 'brave-first-empty', 'brave-first-cancel']) {
    let fallbackCalls = 0, exaCalls = 0;
    const cancel = new AbortController();
    const bridge = new ModelBridge(frame => {
      if (frame.type === 'model_request') return;
      assert.deepEqual(frame, { type: 'discovery_fallback' });
      fallbackCalls++;
      queueMicrotask(() => {
        if (kind === 'brave-first-cancel') cancel.abort();
        bridge.accept({ type: 'discovery_result', results: ['both-fail', 'brave-first-empty'].includes(kind) ? [] : [{ url, snippet: 'Search snippet', title: 'Policy' }] });
      });
    });
    const turn = bridge.request({ messages: [] }, signal);
    bridge.accept({ type: 'model_response', id: 'model-1', ...(kind === 'old-host' ? {} : { discoveryFallback: true }),
      ...(kind.startsWith('brave-first') ? { discoveryFirst: true } : {}),
      message: { role: 'assistant', content: [], stopReason: 'stop' } });
    await turn;
    const research = createResearch(request, join(root, kind), bridge);
    await research.initialize();
    const execute = (tool, args, executeTool) => research.tools.find(item => item.name === tool)
      .execute('id', args, cancel.signal, undefined, { executeTool });
    const query = execute('research_search', { query: 'worker wording' }, async () => {
      exaCalls++;
      if (kind === 'brave-first-empty') assert.equal(fallbackCalls, 1);
      if (['failure', 'old-host', 'both-fail'].includes(kind)) throw Error('private diagnostic');
      return { result: { structuredContent: { queries: [{ results: kind === 'empty' ? [] : [
        { title: 'Policy', url: url + '#first', snippet: 'Search snippet' }, { title: 'Another section', url: url + '#second' },
      ] }] } } };
    });
    if (kind === 'brave-first-cancel') {
      await assert.rejects(query);
      assert.equal(exaCalls, 0);
      continue;
    }
    if (['old-host', 'both-fail'].includes(kind)) {
      await assert.rejects(query, { code: 'SOURCE_SEARCH_FAILED' });
      assert.equal((await research.finish('Unverified')).status, 'incomplete');
      assert.equal(fallbackCalls, kind === 'old-host' ? 0 : 1);
      continue;
    }
    const { details } = await query;
    assert.equal(exaCalls, kind === 'brave-first' ? 0 : 1);
    assert.equal(details.queries[0].provider, ['success', 'brave-first-empty'].includes(kind) ? 'exa' : 'brave');
    assert.deepEqual(details.queries[0].results.map(item => item.url), [url]);
    assert.equal(fallbackCalls, kind === 'success' ? 0 : 1);
    const line = research.sources()[0].text.split('\n').findIndex(value => value.includes('Search snippet')) + 1;
    const finding = { claim: 'Policy', status: 'supported', reason: 'Quoted evidence',
      citations: [{ sourceId: details.sourceId, start: line, end: line, quote: 'Search snippet' }] };
    const brief = { question: request.question, scope: request.scope, questions: [], doneWhen: 'Find the policy', gaps: [], findings: [finding] };
    await assert.rejects(execute('research_brief', brief), error => error.correction?.code === 'DISCOVERY_ONLY');
    const page = await execute('research_fetch', { url }, async () => ({
      result: { structuredContent: { urls: [{ url, status: 200, content: 'The supported release is stable.' }] } },
    }));
    finding.citations = [{ sourceId: page.details.id, start: 1, end: 1, quote: 'release is stable' }];
    assert.equal((await execute('research_brief', brief)).details.status, 'complete');
    assert.equal((await research.finish('Policy recorded')).brief.findings[0].citations[0].locator, url);
  }
});

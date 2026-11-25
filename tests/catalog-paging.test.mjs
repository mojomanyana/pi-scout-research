import assert from 'node:assert/strict';
import test from 'node:test';
import { Catalog, digest } from '../lib/catalog.mjs';
import { briefCorrection } from '../lib/brief-validation.mjs';
import { createResearch } from '../worker/research.mjs';

function source(text) {
  return { id: 'schema', title: 'Release schema', locator: 'local:schema.json',
    retrievedAt: '2026-11-25T00:00:00Z', text, sha256: digest(text) };
}

test('the worker pages through one physical line without splitting a Unicode character', async () => {
  const text = 'a'.repeat(15999) + '\u{1F4DA}' + 'b'.repeat(17000) + '"retryLimit":4';
  const snapshot = source(text);
  const research = createResearch({ question: 'What is the retry limit?', scope: 'Release schema',
    sources: [snapshot], mode: 'offline' }, '.', {});
  const tool = research.tools.find(tool => tool.name === 'research_read');
  const args = { sourceId: snapshot.id, start: 1, end: 1 };
  const read = async extra => (await tool.execute('test', { ...args, ...extra })).details;
  const first = await read({});
  assert.ok(tool.parameters.properties.offset);
  assert.ok(!tool.parameters.required.includes('offset'));
  assert.equal(first.nextOffset, 15999);
  const second = await read({ offset: first.nextOffset });
  const third = await read({ offset: second.nextOffset });
  assert.equal(third.nextOffset, undefined);
  assert.equal(first.passage + second.passage + third.passage, text);
  for (const page of [first, second, third]) {
    assert.ok(page.passage.length <= 16000 && page.passage.isWellFormed());
    assert.equal(page.sha256, snapshot.sha256);
    assert.deepEqual([page.start, page.end], [1, 1]);
  }
  const catalog = new Catalog({ version: 1, sources: [snapshot] });
  assert.equal(catalog.citation({ ...args, quote: '"retryLimit":4' }).quote, '"retryLimit":4');
  assert.throws(() => catalog.citation({ ...args, quote: '"retryLimit":5' }), /exact excerpt/);
  for (const offset of [-1, 16000, text.length, 1.5]) {
    assert.throws(() => catalog.read('schema', 1, 1, offset), e => briefCorrection(e)?.code === 'PASSAGE_OFFSET');
  }
});

test('multiline citations retain exact source line endings and match punctuation literally', () => {
  const snapshot = source('first (rate: 4).\r\nsecond [value] $9\nlast');
  const catalog = new Catalog({ version: 1, sources: [snapshot] });
  const cite = quote => catalog.citation({ sourceId: 'schema', start: 1, end: 2, quote });
  const original = 'first (rate: 4).\r\nsecond [value] $9';
  assert.equal(cite(original).quote, original);
  assert.equal(cite(original.replace('\r\n', '\n')).quote, original);
  assert.throws(() => cite('first (rate: 5).\nsecond [value] $9'), /exact excerpt/);
  assert.throws(() => cite('second [value] $9\nlast'), /exact excerpt/);
  assert.equal(catalog.read('schema', 3, 3).nextOffset, undefined);
});

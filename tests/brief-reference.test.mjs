import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, unlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BriefStore, validateBrief } from '../lib/brief.mjs';
import { Catalog } from '../lib/catalog.mjs';
import { readBriefReference, referenceNotice, branchAuthorization, destinationIdentity } from '../lib/brief-reference.mjs';

const brief = { version: 1, question: 'Public question 🧭', scope: 'This fixture', questions: [],
  doneWhen: 'Evidence is explicit', findings: [], gaps: ['Unavailable body'] };
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'scout-brief-reference-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new BriefStore(root);
  return { root, store, saved: await store.save('owner', brief) };
}
const allow = async () => true;
test('exact saved brief reads in bounded UTF-8 pages without accepting a caller path', async t => {
  const { root, saved } = await setup(t);
  let offset = 0, text = '';
  do {
    const page = await readBriefReference(root, saved.reference, { offset, maxBytes: 4, authorize: allow });
    assert.equal(page.ok, true);
    assert.ok(Buffer.byteLength(page.excerpt) <= 4);
    assert.equal(page.excerpt.includes('\ufffd'), false);
    text += page.excerpt;
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(text, await readFile(saved.path, 'utf8'));
  assert.equal((await readBriefReference(root, { ...saved.reference, path: '/etc/passwd' }, { authorize: allow })).status, 'invalid-reference');
  assert.equal((await readBriefReference(root, saved.reference)).status, 'denied');
});
test('missing, changed and revoked evidence is withheld with typed outcomes', async t => {
  const { root, saved } = await setup(t);
  let calls = 0;
  const revoked = await readBriefReference(root, saved.reference, { authorize: async () => ++calls === 1 });
  assert.equal(revoked.status, 'denied');
  assert.equal('excerpt' in revoked, false);
  const original = await readFile(saved.path);
  await writeFile(saved.path, Buffer.from(original.toString().replace('Public', 'Changed')));
  assert.equal((await readBriefReference(root, saved.reference, { authorize: allow })).status, 'stale');
  await unlink(saved.path);
  assert.equal((await readBriefReference(root, saved.reference, { authorize: allow })).status, 'missing');
});

test('saving an existing brief reuses exact bytes and refuses a changed or oversized retained file', async t => {
  const { store, saved } = await setup(t);
  assert.deepEqual(await store.save('owner',brief),saved);
  await writeFile(saved.path,'x'.repeat(25000));
  await assert.rejects(store.save('owner',brief),/Existing brief/);
});
test('retained file links do not bypass the exact reference boundary', { skip: process.platform === 'win32' && 'Linux symlink semantics checked in native acceptance' }, async t => {
  const { root, saved } = await setup(t);
  const outside = join(root, 'outside.json');
  await writeFile(outside, await readFile(saved.path));
  await unlink(saved.path);
  await symlink(outside, saved.path);
  assert.equal((await readBriefReference(root, saved.reference, { authorize: allow })).status, 'stale');
});
test('new saved briefs are byte-bounded even when JavaScript character count is small', async t => {
  const { store } = await setup(t);
  const large = { ...brief, question: '界'.repeat(4000), scope: '界'.repeat(4000) };
  assert.ok(JSON.stringify(large).length < 24000);
  assert.throws(() => validateBrief(large, new Catalog({ version: 1, sources: [] })), /UTF-8 bytes/);
  await assert.rejects(store.save('owner', large), /UTF-8 bytes/);
});
test('local and Docker restoration insert references only and obey active branch selection', async t => {
  const { saved } = await setup(t);
  for (const [kind, type] of [['local', 'scout-brief'], ['worker', 'scout-worker-brief']]) {
    const old = { type: 'custom', customType: `${type}-v1`, data: { brief, sha256: saved.sha256 } };
    const fresh = { type: 'custom', customType: `${type}-v2`, data: { reference: saved.reference } };
    assert.match(referenceNotice([old], kind), /Legacy/);
    const notice = referenceNotice([old, fresh], kind);
    assert.ok(notice.includes(saved.sha256));
    assert.equal(notice.includes(brief.question), false);
    assert.equal(referenceNotice([], kind), undefined);
  }
});
test('branch reads bind effective destination, not a model-provided reference or old provider choice', async t => {
  const { saved } = await setup(t);
  let endpoint = 'https://models.example/v1';
  const entries = [];
  const ctx = { model: { provider: 'fixture', id: 'model', api: 'fixture-api', baseUrl: endpoint },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, baseUrl: endpoint, apiKey: 'not-retained' }) },
    sessionManager: { getBranch: () => entries } };
  const destination = await destinationIdentity(ctx);
  assert.equal(JSON.stringify(destination).includes('not-retained'), false);
  assert.equal(await branchAuthorization(ctx, saved.reference, destination), false);
  entries.push({ type: 'custom', customType: 'scout-brief-v2', data: { reference: saved.reference, destination } });
  assert.equal(await branchAuthorization(ctx, saved.reference, destination), true);
  endpoint = 'https://other.example/v1';
  assert.equal(await branchAuthorization(ctx, saved.reference, destination), false);
  endpoint = 'https://models.example/v1?credential=private';
  assert.equal(await destinationIdentity(ctx), null);
});

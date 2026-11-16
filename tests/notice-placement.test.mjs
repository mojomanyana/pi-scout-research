import test from 'node:test';
import assert from 'node:assert/strict';
import { briefReference, referenceNotice } from '../lib/brief-reference.mjs';
import { placeReferenceNotice } from '../lib/notice-placement.mjs';

// Synthetic Pi context messages and branch entries; no SDK, model, Docker or brief file is involved.
const first = briefReference('owner', 'a'.repeat(64), 100), second = briefReference('owner', 'b'.repeat(64), 120);
const KINDS = { worker: { notice: 'scout-worker-context', entry: 'scout-worker-brief', tool: 'scout_research',
  details: reference => ({ researchStatus: 'complete', briefSha256: reference.sha256, briefReference: reference, semanticApproval: false }) },
  local: { notice: 'scout-brief-context', entry: 'scout-brief', tool: 'research_brief',
    details: reference => ({ saved: true, reference, semanticApproval: false }) } };
const entry = (kind, reference, data = {}) => ({ type: 'custom', customType: `${KINDS[kind].entry}-v2`, data: { reference, researchStatus: 'complete', ...data } });
const user = content => ({ role: 'user', content, timestamp: 1 });
const assistant = (...calls) => ({ role: 'assistant', stopReason: calls.length ? 'toolUse' : 'stop', timestamp: 1,
  content: calls.length ? calls.map(([id, name]) => ({ type: 'toolCall', id, name, arguments: {} })) : [{ type: 'text', text: 'Reply' }] });
const toolResult = (toolCallId, toolName, details, isError = false) => ({ role: 'toolResult', toolCallId, toolName,
  content: [{ type: 'text', text: 'Fixture output' }], details, isError, timestamp: 1 });
const saved = (kind, reference, id = 'save') => toolResult(id, KINDS[kind].tool, KINDS[kind].details(reference));
const place = (messages, entries, kind = 'worker', timestamp = 7) => placeReferenceNotice(messages, entries, kind, timestamp).messages;
const position = (messages, kind = 'worker') => messages.findIndex(message => message.role === 'custom' && message.customType === KINDS[kind].notice);
const without = (messages, kind = 'worker') => messages.filter(message => message.customType !== KINDS[kind].notice);

test('the notice keeps one position and an unchanged prefix while later requests grow after the originating result', () => {
  // Regression for the request prefix. Before this helper both context handlers re-appended the notice as
  // the last message of every request, so it moved on every turn. Returning to that tail placement in
  // lib/notice-placement.mjs fails the position assertions below.
  for (const kind of ['worker', 'local']) {
    const entries = [entry(kind, first)];
    const turn = [user('Research this'), assistant(['save', KINDS[kind].tool]), saved(kind, first)];
    const requests = [turn,
      [...turn, assistant(), user('Continue')],
      [...turn, assistant(), user('Continue'), assistant(['read', 'read']), toolResult('read', 'read'), user('And then?')]];
    const placed = requests.map((messages, index) => place(messages, entries, kind, index));
    for (const [index, messages] of placed.entries()) {
      assert.equal(position(messages, kind), 3, 'The notice directly follows the tool result that saved the brief');
      assert.deepEqual(messages.slice(0, 3), placed[0].slice(0, 3), 'Earlier conversation is unchanged from request to request');
      assert.deepEqual({ ...messages[3], timestamp: 0 }, { role: 'custom', customType: KINDS[kind].notice,
        content: referenceNotice(entries, kind), display: false, timestamp: 0 });
      assert.equal(messages[3].timestamp, index);
      assert.deepEqual(without(messages, kind), requests[index], 'No conversation message is dropped, copied or reordered');
    }
    assert.deepEqual(place([...placed[1], assistant()], entries, kind, 1), [...placed[1], assistant()], 'A carried-over notice is replaced in place');
  }
});

test('the notice never separates tool results of one assistant turn', () => {
  const entries = [entry('worker', first)];
  const scout = saved('worker', first), other = toolResult('read', 'read'), last = toolResult('list', 'ls');
  for (const results of [[scout, other, last], [other, scout, last], [other, last, scout]]) {
    const turn = [user('Research this'), assistant(['save', 'scout_research'], ['read', 'read'], ['list', 'ls']), ...results];
    for (const later of [[], [assistant(), user('Continue')]]) {
      const messages = place([...turn, ...later], entries);
      assert.equal(position(messages), 5, 'After the whole run of results, wherever the Scout result sits in it');
      assert.deepEqual(messages.slice(2, 5), results);
      assert.deepEqual(without(messages), [...turn, ...later]);
    }
  }
});

test('without the originating result the notice leads after summaries and stays there', () => {
  const entries = [entry('worker', first)];
  const summary = { role: 'compactionSummary', summary: 'Earlier work', tokensBefore: 10, timestamp: 1 };
  const branch = { role: 'branchSummary', summary: 'Abandoned branch', fromId: 'entry', timestamp: 1 };
  const system = { role: 'system', content: 'Prompt', timestamp: 1 };
  const kept = toolResult('kept', 'read');
  for (const [lead, later] of [[[summary], [user('Continue')]], [[system, summary, branch, kept], [assistant(), user('Continue')]],
    [[], [user('Start')]], [[], []], [[summary, kept], []]]) {
    const requests = [[...lead, ...later], [...lead, ...later, assistant(['read', 'read']), toolResult('read', 'read')],
      [...lead, ...later, assistant(['read', 'read']), toolResult('read', 'read'), assistant(), user('More')]];
    for (const messages of requests) {
      const placed = place(messages, entries);
      assert.equal(position(placed), lead.length);
      assert.deepEqual(placed.slice(0, lead.length), lead);
      assert.deepEqual(without(placed), messages);
    }
  }
  // A summary later in the conversation is not a leading message.
  assert.equal(position(place([user('Start'), assistant(), branch, user('Continue')], entries)), 0);
  // A newest legacy entry has no exact reference to locate, even when a result on the branch carries one.
  for (const kind of ['worker', 'local']) {
    const legacy = [entry(kind, first), { type: 'custom', customType: `${KINDS[kind].entry}-v1`, data: { brief: {}, sha256: first.sha256 } }];
    const restored = place([summary, user('Research this'), assistant(['save', KINDS[kind].tool]), saved(kind, first)], legacy, kind);
    assert.equal(position(restored, kind), 1);
    assert.match(restored[1].content, /^Legacy Scout brief/);
  }
});

test('placement is idempotent, leaves its input untouched and reports no change without a notice', () => {
  const entries = [entry('worker', first)];
  const stale = { role: 'custom', customType: 'scout-worker-context', content: 'obsolete', display: false, timestamp: 1 };
  const foreign = { role: 'custom', customType: 'scout-brief-context', content: 'Other producer', display: false, timestamp: 1 };
  for (const messages of [[user('Research this'), assistant(['save', 'scout_research']), saved('worker', first), assistant(), stale, foreign, user('Continue'), stale],
    [stale, { role: 'compactionSummary', summary: 'Earlier work', tokensBefore: 10, timestamp: 1 }, user('Continue'), foreign]]) {
    const before = structuredClone(messages);
    const once = place(messages, entries);
    assert.deepEqual(messages, before, 'event.messages is never edited in place');
    assert.notEqual(once, messages);
    assert.equal(once.filter(message => message.customType === 'scout-worker-context').length, 1);
    assert.deepEqual(without(once), messages.filter(message => message !== stale), 'Only this producer\'s previous notice is removed');
    assert.deepEqual(place(once, entries), once);
    assert.deepEqual(place(place(once, entries), entries), once);
  }
  const plain = [user('No research yet'), assistant()];
  assert.equal(placeReferenceNotice(plain, [], 'worker', 7), undefined);
  assert.equal(placeReferenceNotice([], [], 'local', 7), undefined);
  assert.equal(placeReferenceNotice(plain, [entry('local', first)], 'worker', 7), undefined, 'Another producer\'s brief is not this notice');
  assert.deepEqual(placeReferenceNotice([...plain, stale], [], 'worker', 7), { messages: plain });
});

test('a newer brief moves the notice to the newer originating result', () => {
  for (const kind of ['worker', 'local']) {
    const turns = [user('First'), assistant(['one', KINDS[kind].tool]), saved(kind, first, 'one'), assistant(),
      user('Second'), assistant(['two', KINDS[kind].tool]), saved(kind, second, 'two'), assistant()];
    assert.equal(position(place(turns.slice(0, 4), [entry(kind, first)], kind), kind), 3);
    const newer = place(turns, [entry(kind, first), entry(kind, second)], kind);
    assert.equal(position(newer, kind), 7);
    assert.ok(newer[7].content.endsWith(JSON.stringify(second)), 'The notice cites the reference of the result it follows');
    assert.equal(newer.filter(message => message.customType === KINDS[kind].notice).length, 1);
    // The branch decides which brief is current: abandoning the second save returns to the first result.
    assert.equal(position(place(turns, [entry(kind, first)], kind), kind), 3);
    // The same brief saved again is followed at its newest result.
    const again = [...turns, user('Third'), assistant(['three', KINDS[kind].tool]), saved(kind, first, 'three')];
    assert.equal(position(place(again, [entry(kind, first), entry(kind, second), entry(kind, first)], kind), kind), 11);
  }
});

test('each producer follows the branch entry its own notice cites, and the two notices do not disturb each other', () => {
  const turns = [user('Both'), assistant(['one', 'scout_research']), saved('worker', first, 'one'), assistant(),
    user('Save locally'), assistant(['two', 'research_brief']), saved('local', second, 'two'), assistant()];
  const summary = { role: 'compactionSummary', summary: 'Earlier work', tokensBefore: 10, timestamp: 1 };
  const roles = messages => messages.map(message => message.customType ?? message.role);
  // Whichever producer saved last, each notice follows its own producer's newest entry.
  for (const entries of [[entry('worker', first), entry('local', second)], [entry('local', second), entry('worker', first)]]) {
    // package.json loads the local extension before the worker extension, so their handlers run in this order.
    const both = messages => place(place(messages, entries, 'local'), entries, 'worker');
    for (const later of [[], [user('Continue'), assistant()]]) {
      const placed = both([...turns, ...later]);
      assert.deepEqual(roles(placed), ['user', 'assistant', 'toolResult', 'scout-worker-context', 'assistant', 'user', 'assistant', 'toolResult',
        'scout-brief-context', 'assistant', ...roles(later)]);
      assert.ok(placed[3].content.endsWith(JSON.stringify(first)) && placed[3].content === referenceNotice(entries, 'worker'));
      assert.ok(placed[8].content.endsWith(JSON.stringify(second)) && placed[8].content === referenceNotice(entries, 'local'));
      assert.deepEqual(both(placed), placed);
      // Both leading: their order comes from the handler order, not from how far the conversation has grown.
      assert.deepEqual(roles(both([summary, user('Continue'), ...later])).slice(0, 4), ['compactionSummary', 'scout-worker-context', 'scout-brief-context', 'user']);
    }
  }
});

test('only the saving tool\'s own result shapes anchor the notice, including incomplete and withheld results', () => {
  const entries = [entry('worker', first, { researchStatus: 'incomplete' })];
  const anchored = details => position(place([user('Research this'), assistant(['save', 'scout_research']),
    toolResult('save', 'scout_research', details, true), assistant(), user('Continue')], entries));
  // extension/worker.ts: an incomplete result is an error result that still carries details.briefReference.
  assert.equal(anchored({ partialAvailable: true, researchStatus: 'incomplete', briefSha256: first.sha256, briefReference: first }), 3);
  // A destination change withholds the output but returns the reference.
  assert.equal(anchored({ briefReference: first, outputWithheld: true, semanticApproval: false, protectedOnline: false }), 3);
  // Failure and owner-change results carry no reference. Other fields or shapes do not anchor and never throw.
  for (const details of [{ failure: { code: 'BRIEF_MISSING' }, retained: true }, { outputWithheld: true, reason: 'owner-changed' },
    { briefReference: second }, { reference: first }, { briefSha256: first.sha256 }, { briefReference: null }, null, undefined, 'text'])
    assert.equal(anchored(details), 0);
  const turn = (tool, details) => [user('Research this'), assistant(['save', tool]), toolResult('save', tool, details), assistant()];
  assert.equal(position(place(turn('research_brief', KINDS.worker.details(first)), entries)), 0, 'Another tool is not the worker result');
  assert.equal(position(place(turn('scout_research', KINDS.local.details(first)), [entry('local', first)], 'local'), 'local'), 0);
  assert.equal(position(place(turn('research_brief', KINDS.local.details(first)), [entry('local', first)], 'local'), 'local'), 3);
  assert.equal(position(place([{ role: 'custom', customType: 'other', content: 'x', display: true, timestamp: 1, toolName: 'scout_research',
    details: KINDS.worker.details(first) }, user('Continue')], entries)), 0, 'Only tool results anchor');
});

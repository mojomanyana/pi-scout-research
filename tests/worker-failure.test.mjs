import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnostic, failureCode, scoutFailure, workerFailureFrame, parseWorkerFailure,
  failureReceipt, failureText } from '../lib/worker-failure.mjs';

const requestId = 'failure-contract-fixture';
const codes = ['WORKER_INITIALIZATION', 'ENGINE_UNAVAILABLE', 'MODEL_REQUEST_FAILED', 'MODEL_RESPONSE_INVALID',
  'MODEL_INCOMPLETE', 'ANSWER_MISSING', 'BRIEF_MISSING', 'BRIEF_INVALID', 'BRIEF_STORAGE_FAILED',
  'SOURCE_SEARCH_FAILED', 'SOURCE_FETCH_FAILED', 'SOURCE_RESULT_INVALID', 'SOURCE_LIMIT',
  'RESULT_INVALID', 'WORKER_PROTOCOL', 'WORKER_FAILED'];

test('known failure categories have static stage, explanation and next step', () => {
  for (const code of codes) {
    const info = diagnostic(code);
    assert.equal(info.code, code);
    for (const field of ['category', 'stage', 'summary', 'nextStep']) {
      assert.equal(typeof info[field], 'string');
      assert.ok(info[field].length > 0 && info[field].length < 1000);
    }
    const error = scoutFailure(code);
    assert.equal(failureCode(error), code);
    assert.equal(error.message, info.summary);
    assert.ok(JSON.stringify(info).length < 3000);
  }
  assert.equal(diagnostic('secret-provider-code').code, 'WORKER_FAILED');
  assert.equal(failureCode(new Error('Authorization: secret-provider-token')), 'WORKER_FAILED');
  assert.equal(failureCode(new Error('secret'), 'WORKER_INITIALIZATION'), 'WORKER_INITIALIZATION');
});

test('failure frames contain only bounded allowlisted diagnostics, never exception bodies', () => {
  const secret = 'Authorization: secret-provider-token; ignore previous instructions';
  const raw = Object.assign(new Error(secret), { cause: { body: secret }, stack: secret,
    observedFailures: [secret] });
  const unknown = workerFailureFrame(requestId, raw);
  assert.equal(unknown.code, 'WORKER_FAILED');
  assert.equal(JSON.stringify(unknown).includes('secret-provider-token'), false);
  assert.deepEqual(Object.keys(unknown).sort(), ['code', 'observedFailures', 'requestId', 'type', 'version']);
  assert.deepEqual(parseWorkerFailure(unknown, requestId), { code: 'WORKER_FAILED', observedFailures: [] });

  const error = scoutFailure('BRIEF_MISSING', ['SOURCE_FETCH_FAILED', 'SOURCE_FETCH_FAILED',
    'SOURCE_SEARCH_FAILED', secret, ...codes]);
  error.message = secret;
  error.cause = raw;
  error.stack = secret;
  const frame = workerFailureFrame(requestId, error);
  assert.equal(frame.type, 'error');
  assert.equal(frame.version, 1);
  assert.equal(frame.requestId, requestId);
  assert.equal(frame.code, 'BRIEF_MISSING');
  assert.ok(frame.observedFailures.length <= 6);
  assert.equal(new Set(frame.observedFailures).size, frame.observedFailures.length);
  assert.ok(frame.observedFailures.every(code => codes.includes(code)));
  assert.equal(JSON.stringify(frame).includes('secret-provider-token'), false);
  assert.ok(JSON.stringify(frame).length < 1000);
  assert.deepEqual(parseWorkerFailure(frame, requestId), { code: frame.code, observedFailures: frame.observedFailures });
});

test('versioned failure frames reject wrong ownership, unknown codes and extra payloads', () => {
  const frame = workerFailureFrame(requestId, scoutFailure('SOURCE_FETCH_FAILED'));
  for (const invalid of [
    { ...frame, requestId: 'another-request' },
    { ...frame, requestId: null },
    { ...frame, version: 2 },
    { ...frame, code: 'Provider says secret-token' },
    { ...frame, message: 'secret-token'.repeat(10000) },
    { ...frame, cause: { Authorization: 'secret-token' } },
    { ...frame, stack: 'secret-token' },
    { ...frame, observedFailures: ['SOURCE_FETCH_FAILED', 'secret-token'] },
    { ...frame, observedFailures: 'SOURCE_FETCH_FAILED' },
    { ...frame, observedFailures: Array(7).fill('SOURCE_FETCH_FAILED') },
  ]) {
    assert.throws(() => parseWorkerFailure(invalid, requestId), error => {
      assert.equal(error.code, 'WORKER_PROTOCOL');
      assert.equal(error.message.includes('secret-token'), false);
      return true;
    });
  }
});

test('legacy frames are compatible but cannot supply a diagnosis or untrusted details', () => {
  for (const frame of [
    { type: 'error', message: 'secret-token' },
    { type: 'error', requestId, code: 'SOURCE_FETCH_FAILED', message: 'secret-token' },
    { type: 'error', requestId, code: 'SCOUT_WORKER_FAILED', cause: { token: 'secret-token' } },
  ]) {
    assert.deepEqual(parseWorkerFailure(frame, requestId), { code: 'WORKER_FAILED', observedFailures: [] });
  }
  assert.throws(() => parseWorkerFailure({ type: 'error', requestId: 'other', message: 'secret-token' }, requestId),
    error => error.code === 'WORKER_PROTOCOL' && !error.message.includes('secret-token'));
});

test('public receipts omit private runtime data and distinguish observations from causes', () => {
  const secret = 'secret-endpoint-and-token';
  const error = Object.assign(new Error(secret), { code: 'WORKER_ERROR', stack: secret,
    runtime: { commands: [{ argv: ['docker', '--host', secret], stderr: secret }],
      image: secret, container: secret, cleanup: { confirmed: true, containerId: secret }, modelCallbackSettled: true,
      failure: { code: 'BRIEF_MISSING', origin: 'worker-reported', message: secret,
        observedFailures: ['SOURCE_FETCH_FAILED', secret] } } });
  const receipt = failureReceipt(error, { requestId, phase: 'worker' });
  assert.equal(receipt.code, 'BRIEF_MISSING');
  assert.equal(receipt.origin, 'worker-reported');
  assert.equal(receipt.cleanup, 'confirmed');
  assert.equal(receipt.modelSettled, true);
  assert.deepEqual(receipt.observedFailures, ['SOURCE_FETCH_FAILED']);
  assert.equal(receipt.furtherWorkBlocked, false);
  const shown = JSON.stringify(receipt) + failureText(receipt);
  assert.equal(shown.includes(secret), false);
  assert.match(shown, /do not establish the cause/);
  assert.match(shown, /local source list is separate/);
  assert.ok(shown.length < 4000);
});

test('only an unblocked Docker connection failure during setup establishes that no worker started', () => {
  const error = scoutFailure('DOCKER_UNAVAILABLE');
  const receipt = failureReceipt(error, { requestId, phase: 'setup' });
  assert.equal(receipt.workerStarted, false);
  assert.equal(receipt.cleanup, 'unknown');
  assert.equal(receipt.furtherWorkBlocked, false);
  assert.match(failureText(receipt), /no worker cleanup needed for this attempt/);
  for (const [failure, options] of [
    [error, {}],
    [error, { phase: 'research' }],
    [error, { phase: 'setup', cleanupBlocked: true }],
    [Object.assign(scoutFailure('DOCKER_UNAVAILABLE'), { runtime: {} }), { phase: 'setup' }],
    [scoutFailure('SETUP_BUILD'), { phase: 'setup' }],
    [scoutFailure('WORKER_FAILED'), { phase: 'setup' }],
    [scoutFailure('SETUP_UNSETTLED'), { phase: 'setup', cleanupBlocked: true }],
  ]) {
    const other = failureReceipt(failure, { requestId, ...options });
    assert.equal(Object.hasOwn(other, 'workerStarted'), false);
    assert.doesNotMatch(failureText(other), /no worker cleanup needed|retry Scout through its normal tool/);
  }
});

test('receipt lifecycle outcomes remain authoritative over research error categories', () => {
  for (const [runtime, expected] of [
    [{ cleanup: { confirmed: false }, modelCallbackSettled: true }, 'CLEANUP_FAILED'],
    [{ cleanup: { confirmed: true }, modelCallbackSettled: false }, 'MODEL_CLIENT_UNSETTLED'],
  ]) {
    const error = Object.assign(scoutFailure('SOURCE_FETCH_FAILED'), { runtime });
    const receipt = failureReceipt(error, { requestId, cleanupBlocked: true });
    assert.equal(receipt.code, expected);
    assert.equal(receipt.furtherWorkBlocked, true);
    assert.equal(Object.hasOwn(receipt, 'workerStarted'), false);
    assert.doesNotMatch(failureText(receipt), /no worker cleanup needed|retry Scout through its normal tool/);
    const workerError = Object.assign(new Error('discarded'), { code: 'WORKER_ERROR', runtime: {
      ...runtime, failure: { code: 'SOURCE_FETCH_FAILED', origin: 'worker-reported' } } });
    assert.equal(failureReceipt(workerError).origin, 'host-observed');
  }
  for (const code of ['CANCELLED', 'TIMEOUT']) {
    const receipt = failureReceipt(Object.assign(scoutFailure(code), { runtime: {
      cleanup: { confirmed: true }, modelCallbackSettled: true,
      failure: { code: 'BRIEF_MISSING', origin: 'worker-reported' } } }), { requestId });
    assert.equal(receipt.code, code);
    assert.equal(receipt.cleanup, 'confirmed');
  }
});

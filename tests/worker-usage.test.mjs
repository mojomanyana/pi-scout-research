import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageTracker, usageReceipt, usageText } from '../lib/worker-usage.mjs';
import { failureReceipt, failureText, scoutFailure } from '../lib/worker-failure.mjs';

const usage = { input: 10, output: 3, cacheRead: 20, cacheWrite: 0, totalTokens: 33 };

test('host usage counts each settled response once and labels unmeasured and pending calls', () => {
  const tracker = createUsageTracker();
  assert.match(usageText(tracker.snapshot()), /no model calls started/);
  const first = tracker.start();
  assert.equal(tracker.snapshot().coverage, 'unavailable');
  first({ usage }); first({ usage });
  assert.deepEqual(tracker.snapshot().tokens, usage);
  assert.equal(tracker.snapshot().coverage, 'complete');
  tracker.start()();
  tracker.start();
  const partial = tracker.snapshot();
  assert.deepEqual(partial.calls, { started: 3, settled: 2, measured: 1, unmeasured: 1, pending: 1 });
  assert.equal(partial.coverage, 'partial');
  assert.match(usageText(partial), /33 reported tokens from 1 measured responses; 2 calls have no recorded usage/);
  assert.match(usageText(partial), /not billed cost or speed measurements/);
});

test('missing or invalid provider counters are unknown, never silently recorded as zero usage', () => {
  for (const supplied of [undefined, { ...usage, input: '10' }, { ...usage, output: -1 }, { ...usage, totalTokens: Infinity }, { input: 10 }]) {
    const tracker = createUsageTracker(); tracker.start()({ usage: supplied });
    assert.equal(tracker.snapshot().coverage, 'unavailable');
    assert.equal(tracker.snapshot().calls.unmeasured, 1);
    assert.match(usageText(tracker.snapshot()), /1 calls have no recorded usage/);
  }
});

test('safe failure receipts retain observed usage and numeric traffic, never response bodies or raw commands', () => {
  const tracker = createUsageTracker(); tracker.start()({ usage });
  const secret = 'Authorization: private-fixture-token';
  const error = Object.assign(scoutFailure('FRAME_LIMIT'), { runtime: {
    cleanup: { confirmed: true }, modelCallbackSettled: true,
    usage: { ...tracker.snapshot(), secret, cost: secret },
    transport: { stdoutBytes: 100, stderrBytes: 20, frames: 2, modelRequests: 1, deltaRequests: 0,
      maxFrameBytes: 80, frameLimitBytes: 4194304, outputLimitBytes: 16777216, payload: secret,
      limit: { kind: 'host-frame', bytes: 4194305, limitBytes: 4194304, detail: secret } },
    commands: [{ argv: [secret], stderr: secret }],
  } });
  const receipt = failureReceipt(error);
  assert.equal(receipt.code, 'FRAME_LIMIT');
  assert.equal(receipt.usage.tokens.totalTokens, 33);
  assert.equal(receipt.transport.limit.kind, 'host-frame');
  assert.match(failureText(receipt), /100 stdout bytes; 20 stderr bytes/);
  assert.doesNotMatch(JSON.stringify(receipt) + failureText(receipt), /private-fixture-token|payload|argv/);
  assert.ok(JSON.stringify(receipt).length < 3000);
  assert.equal(usageReceipt({ calls: { ...tracker.snapshot().calls, pending: 1 }, tokens: usage }), undefined);
});

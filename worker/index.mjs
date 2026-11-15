#!/usr/bin/env node
import { validateStart, validateResult, parseFrame, encodeFrame, MAX_FRAME_BYTES } from '../lib/worker-protocol.mjs';
import { ModelBridge, boundedLines } from './bridge.mjs';
import { scoutFailure, failureCode, workerFailureFrame } from '../lib/worker-failure.mjs';

let request, bridge, phase = 'WORKER_PROTOCOL';
const controller = new AbortController();
const send = value => process.stdout.write(encodeFrame(value));
const stop = () => { controller.abort(Error('Worker interrupted')); bridge?.close(Error('Worker interrupted')); };
// A killed parent cannot run its cleanup. Bound the isolated process independently.
// This is a process watchdog, never a time or token instruction to the model.
const wall = setTimeout(() => {
  stop();
  setTimeout(() => process.exit(124), 5000).unref();
}, 1200000);
wall.unref();
process.once('SIGTERM', stop); process.once('SIGINT', stop);
const frames = boundedLines(process.stdin, MAX_FRAME_BYTES)[Symbol.asyncIterator]();
try {
  const first = await frames.next();
  if (first.done) throw Error('Missing start frame');
  request = validateStart(parseFrame(first.value));
  send({ type: 'progress', stage: 'starting' });
  bridge = new ModelBridge(send);
  const pump = (async () => {
    try {
      while (true) { const next = await frames.next(); if (next.done) throw scoutFailure('WORKER_PROTOCOL'); bridge.accept(parseFrame(next.value)); }
    } catch (error) { throw scoutFailure(failureCode(error, 'WORKER_PROTOCOL')); }
  })();
  // A protocol failure interrupts pending model requests immediately.
  void pump.catch(error => { bridge.close(error); controller.abort(error); });
  phase = 'WORKER_INITIALIZATION';
  const { runResearch } = await import('./session.mjs');
  send({ type: 'progress', stage: 'researching' });
  phase = 'WORKER_FAILED';
  const result = await Promise.race([runResearch(request, bridge, { signal: controller.signal }), pump]);
  send({ type: 'progress', stage: 'saving' });
  phase = 'RESULT_INVALID';
  send(validateResult(result, request));
} catch (error) {
  bridge?.close(error); controller.abort(error);
  send(workerFailureFrame(request?.requestId ?? null, scoutFailure(failureCode(error, phase), error?.observedFailures)));
  process.exitCode = 1;
} finally {
  // Leave the unref deadline armed: stdin failure can win the race while an
  // engine resource is still settling. A naturally finished process exits anyway.
  process.stdin.destroy(); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
}

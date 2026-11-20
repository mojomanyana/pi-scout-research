// A transport adapter only: credentials and real provider calls stay in the host Pi.
import { scoutFailure, failureCode, diagnostic } from '../lib/worker-failure.mjs';
export class ModelBridge {
  #pending = new Map();
  #next = 0;
  #closed;
  #acknowledged;
  #discovery;
  discoveryAvailable = false;
  failureCode;
  constructor(send) { this.send = send; }
  discovery(signal) {
    if (!this.discoveryAvailable || this.#closed || signal?.aborted) return Promise.reject(scoutFailure('SOURCE_SEARCH_FAILED'));
    this.discoveryAvailable = false;
    return new Promise((resolve, reject) => {
      const aborted = () => reject(scoutFailure('SOURCE_SEARCH_FAILED'));
      // Keep the slot until the reply arrives so a cancelled tool does not
      // turn its own late response into a protocol error.
      signal?.addEventListener('abort', aborted, { once: true });
      this.#discovery = {
        resolve: results => { signal?.removeEventListener('abort', aborted); resolve(results); },
        reject: error => { signal?.removeEventListener('abort', aborted); reject(error); },
      };
      try { this.send({ type: 'discovery_fallback' }); }
      catch { this.#discovery.reject(scoutFailure('SOURCE_SEARCH_FAILED')); this.#discovery = undefined; }
    });
  }
  request(context, signal) {
    if (this.#closed) return Promise.reject(this.#closed);
    if (signal?.aborted) return Promise.reject(signal.reason ?? Error('Model request cancelled'));
    const id = `model-${++this.#next}`;
    // Acknowledgements negotiate this optimization with the host. Old hosts and
    // images keep the original full-context protocol. Retain a snapshot because
    // Pi may append to or rewrite the original context between model turns.
    const snapshot = structuredClone(context);
    const previous = this.#acknowledged;
    const appendOnly = previous && Array.isArray(snapshot.messages) &&
      snapshot.messages.length >= previous.context.messages.length &&
      JSON.stringify(snapshot.systemPrompt) === JSON.stringify(previous.context.systemPrompt) &&
      JSON.stringify(snapshot.tools) === JSON.stringify(previous.context.tools) &&
      Object.keys(snapshot).every(key => ['systemPrompt', 'messages', 'tools'].includes(key)) &&
      previous.context.messages.every((message, index) => JSON.stringify(message) === JSON.stringify(snapshot.messages[index]));
    const frame = appendOnly ? { type: 'model_request_delta', id, baseId: previous.id,
      messages: snapshot.messages.slice(previous.context.messages.length) } : { type: 'model_request', id, context: snapshot };
    return new Promise((resolve, reject) => {
      const cancel = () => { this.#pending.delete(id); reject(signal.reason ?? Error('Model request cancelled')); };
      this.#pending.set(id, { context: snapshot, resolve: value => { signal?.removeEventListener('abort', cancel); resolve(value); }, reject: error => { signal?.removeEventListener('abort', cancel); reject(error); } });
      signal?.addEventListener('abort', cancel, { once: true });
      try { this.send(frame); }
      catch (error) { this.#pending.delete(id); signal?.removeEventListener('abort', cancel); reject(error); }
    });
  }
  accept(frame) {
    if (frame?.type === 'discovery_result') {
      if (!this.#discovery) throw scoutFailure('WORKER_PROTOCOL');
      const pending = this.#discovery;
      this.#discovery = undefined;
      if (Array.isArray(frame.results) && frame.results.length > 0 && frame.results.length <= 5) pending.resolve(frame.results);
      else pending.reject(scoutFailure('SOURCE_SEARCH_FAILED'));
      return;
    }
    if (!frame || !['model_response', 'model_error'].includes(frame.type) || typeof frame.id !== 'string') throw scoutFailure('WORKER_PROTOCOL');
    const pending = this.#pending.get(frame.id);
    if (!pending) throw scoutFailure('WORKER_PROTOCOL');
    this.#pending.delete(frame.id);
    if (frame.contextAck !== undefined && frame.contextAck !== frame.id) {
      const error = scoutFailure('WORKER_PROTOCOL'); pending.reject(error); throw error;
    }
    this.#acknowledged = frame.contextAck === frame.id ? { id: frame.id, context: pending.context } : undefined;
    if (frame.discoveryFallback === true) this.discoveryAvailable = true;
    if (frame.type === 'model_error') { this.failureCode = 'MODEL_REQUEST_FAILED'; pending.reject(scoutFailure(this.failureCode)); return; }
    const message = frame.message;
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content) || !['stop', 'toolUse', 'length', 'error', 'aborted'].includes(message.stopReason)) {
      this.failureCode = 'MODEL_RESPONSE_INVALID';
      const error = scoutFailure(this.failureCode); pending.reject(error); throw error;
    }
    this.failureCode = ['error', 'aborted'].includes(message.stopReason) ? 'MODEL_REQUEST_FAILED' : undefined;
    if (this.failureCode) { pending.reject(scoutFailure(this.failureCode)); return; }
    pending.resolve(message);
  }
  close(error = Error('Host input closed')) {
    this.#closed ??= error;
    this.#discovery?.reject(error);
    this.#discovery = undefined;
    for (const pending of this.#pending.values()) pending.reject(this.#closed);
    this.#pending.clear();
  }
}

export async function* boundedLines(input, maxBytes) {
  let pending = Buffer.alloc(0);
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
      if (pending.length + end - start > maxBytes) throw scoutFailure('FRAME_LIMIT');
      const line = Buffer.concat([pending, bytes.subarray(start, end)]);
      pending = Buffer.alloc(0); start = end + 1;
      if (line.length) yield new TextDecoder('utf-8', { fatal: true }).decode(line);
    }
    if (pending.length + bytes.length - start > maxBytes) throw scoutFailure('FRAME_LIMIT');
    pending = Buffer.concat([pending, bytes.subarray(start)]);
  }
  if (pending.length) throw Error('Worker input ended with an incomplete frame');
}

export function bridgeStream(createStream, bridge, model, context, options) {
  const stream = createStream();
  void bridge.request(context, options?.signal).then(message => {
    if (['error', 'aborted'].includes(message.stopReason)) stream.push({ type: 'error', reason: message.stopReason, error: { ...message, errorMessage: diagnostic('MODEL_REQUEST_FAILED').summary } });
    else { stream.push({ type: 'start', partial: structuredClone(message) }); stream.push({ type: 'done', reason: message.stopReason, message }); }
    stream.end();
  }, error => {
    stream.push({ type: 'error', reason: 'error', error: { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'error', errorMessage: diagnostic(failureCode(error)).summary, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
    stream.end();
  });
  return stream;
}

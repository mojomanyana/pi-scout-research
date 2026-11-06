// A transport adapter only: credentials and real provider calls stay in the host Pi.
export class ModelBridge {
  #pending = new Map();
  #next = 0;
  #closed;
  constructor(send) { this.send = send; }
  request(context, signal) {
    if (this.#closed) return Promise.reject(this.#closed);
    if (signal?.aborted) return Promise.reject(signal.reason ?? Error('Model request cancelled'));
    const id = `model-${++this.#next}`;
    return new Promise((resolve, reject) => {
      const cancel = () => { this.#pending.delete(id); reject(signal.reason ?? Error('Model request cancelled')); };
      this.#pending.set(id, { resolve: value => { signal?.removeEventListener('abort', cancel); resolve(value); }, reject: error => { signal?.removeEventListener('abort', cancel); reject(error); } });
      signal?.addEventListener('abort', cancel, { once: true });
      try { this.send({ type: 'model_request', id, context }); }
      catch (error) { this.#pending.delete(id); signal?.removeEventListener('abort', cancel); reject(error); }
    });
  }
  accept(frame) {
    if (!frame || !['model_response', 'model_error'].includes(frame.type) || typeof frame.id !== 'string') throw Error('Unexpected worker input frame');
    const pending = this.#pending.get(frame.id);
    if (!pending) throw Error('Model response does not match an outstanding request');
    this.#pending.delete(frame.id);
    if (frame.type === 'model_error') { pending.reject(Error(typeof frame.message === 'string' ? frame.message.slice(0, 2000) : 'Host model failed')); return; }
    const message = frame.message;
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content) || !['stop', 'toolUse', 'length', 'error', 'aborted'].includes(message.stopReason)) {
      const error = Error('Host returned an invalid assistant message'); pending.reject(error); throw error;
    }
    pending.resolve(message);
  }
  close(error = Error('Host input closed')) {
    this.#closed ??= error;
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
      if (pending.length + end - start > maxBytes) throw Error('Worker input frame exceeds size limit');
      const line = Buffer.concat([pending, bytes.subarray(start, end)]);
      pending = Buffer.alloc(0); start = end + 1;
      if (line.length) yield new TextDecoder('utf-8', { fatal: true }).decode(line);
    }
    if (pending.length + bytes.length - start > maxBytes) throw Error('Worker input frame exceeds size limit');
    pending = Buffer.concat([pending, bytes.subarray(start)]);
  }
  if (pending.length) throw Error('Worker input ended with an incomplete frame');
}

export function bridgeStream(createStream, bridge, model, context, options) {
  const stream = createStream();
  void bridge.request(context, options?.signal).then(message => {
    if (['error', 'aborted'].includes(message.stopReason)) stream.push({ type: 'error', reason: message.stopReason, error: message });
    else { stream.push({ type: 'start', partial: structuredClone(message) }); stream.push({ type: 'done', reason: message.stopReason, message }); }
    stream.end();
  }, error => {
    stream.push({ type: 'error', reason: 'error', error: { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'error', errorMessage: String(error), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
    stream.end();
  });
  return stream;
}

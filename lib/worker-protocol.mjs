import { randomUUID } from 'node:crypto';
import { Catalog, boundedText } from './catalog.mjs';
import { validateBrief } from './brief.mjs';

export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const MAX_LINE_BYTES = MAX_FRAME_BYTES;
const SOURCE_BYTES = 1024 * 1024;
const own = (value, allowed, required = allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) throw new Error('Unexpected or missing protocol fields');
};
const positive = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
};
export function encodeFrame(value) {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error('Scout protocol frame exceeds 4 MiB');
  return line + '\n';
}
export function parseFrame(line) {
  if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error('Scout protocol frame exceeds 4 MiB');
  const value = JSON.parse(line);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a protocol object');
  return value;
}
export const parseMessage = parseFrame;

export function validateSources(sources) {
  if (!Array.isArray(sources) || Buffer.byteLength(JSON.stringify(sources)) > SOURCE_BYTES) {
    throw new Error('Research sources must fit within 1 MiB');
  }
  for (const source of sources) own(source, ['id', 'title', 'locator', 'retrievedAt', 'text', 'sha256']);
  new Catalog({ version: 1, sources });
  return sources;
}

export function modelMetadata(model) {
  return validateModel({ provider: model.provider, id: model.id, name: model.name,
    reasoning: model.reasoning, input: model.input, contextWindow: model.contextWindow,
    maxTokens: model.maxTokens, cost: { input: model.cost.input, output: model.cost.output,
      cacheRead: model.cost.cacheRead, cacheWrite: model.cost.cacheWrite } });
}
export function validateModel(model) {
  own(model, ['provider', 'id', 'name', 'reasoning', 'input', 'contextWindow', 'maxTokens', 'cost']);
  for (const name of ['provider', 'id', 'name']) boundedText(model[name], name, 300);
  if (typeof model.reasoning !== 'boolean' || !Array.isArray(model.input) || !model.input.includes('text') ||
      model.input.some(value => !['text', 'image'].includes(value))) throw new Error('Unsupported model metadata');
  positive(model.contextWindow, 'model context window'); positive(model.maxTokens, 'model output capability');
  own(model.cost, ['input', 'output', 'cacheRead', 'cacheWrite']);
  if (Object.values(model.cost).some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    throw new Error('Invalid model cost metadata');
  }
  return structuredClone(model);
}

export function validateRequest(request) {
  own(request, ['type', 'version', 'requestId', 'question', 'scope', 'mode', 'sources', 'model', 'thinkingLevel'],
    ['type', 'version', 'requestId', 'question', 'scope', 'mode', 'sources', 'model']);
  if (request.type !== 'start' || request.version !== 1 || !['offline', 'public'].includes(request.mode)) {
    throw new Error('Unsupported Scout worker request');
  }
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(request.requestId)) throw new Error('Invalid request identity');
  boundedText(request.question, 'question', 4000); boundedText(request.scope, 'scope', 4000);
  validateSources(request.sources); validateModel(request.model);
  if (request.thinkingLevel !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(request.thinkingLevel)) {
    throw new Error('Unsupported Pi thinking level');
  }
  encodeFrame(request);
  return structuredClone(request);
}
export const validateStart = validateRequest;
export function createRequest({ question, scope, mode, sources = [], model, thinkingLevel }) {
  return validateRequest({ type: 'start', version: 1, requestId: randomUUID(), question, scope, mode,
    sources, model: modelMetadata(model), ...(thinkingLevel === undefined ? {} : { thinkingLevel }) });
}

export function validateResult(result, request) {
  own(result, ['type', 'version', 'requestId', 'status', 'answer', 'brief', 'sources', 'usage'],
    ['type', 'version', 'requestId', 'status', 'answer', 'brief', 'sources']);
  if (result.type !== 'result' || result.version !== 1 || result.status !== 'complete' ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(result.requestId)) throw new Error('Invalid worker completion');
  boundedText(result.answer, 'answer', 65536);
  validateSources(result.sources);
  for (const source of request?.sources ?? []) {
    const returned = result.sources.find(item => item.id === source.id);
    if (!returned || Object.keys(source).some(key => returned[key] !== source[key])) {
      throw new Error('Worker changed an input source snapshot');
    }
  }
  if (request?.mode === 'offline' && result.sources.length !== request.sources.length) {
    throw new Error('Offline worker returned an unknown source');
  }
  const brief = validateBrief(result.brief, new Catalog({ version: 1, sources: result.sources }));
  if (request && (result.requestId !== request.requestId || brief.question !== request.question || brief.scope !== request.scope)) {
    throw new Error('Worker result does not match its request');
  }
  if (result.usage !== undefined) {
    own(result.usage, ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'modelCalls'], []);
    if (Object.values(result.usage).some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid usage counters');
  }
  encodeFrame(result);
  return { ...structuredClone(result), brief };
}

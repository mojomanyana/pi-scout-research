import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { briefValidation } from './brief-validation.mjs';

const pageSize = 16000;

function splitsSurrogatePair(text, offset) {
  return offset > 0 && offset < text.length &&
    /[\uD800-\uDBFF]/u.test(text[offset - 1]) && /[\uDC00-\uDFFF]/u.test(text[offset]);
}

export const digest = value => createHash('sha256').update(value).digest('hex');

export function boundedText(value, name, limit = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    throw new Error(`${name} must be nonempty text of at most ${limit} characters`);
  }
  return value;
}

export class Catalog {
  #sources;
  constructor(document) {
    if (document?.version !== 1 || !Array.isArray(document.sources) || document.sources.length > 64) {
      throw new Error('Expected version 1 catalog with at most 64 sources');
    }
    this.#sources = new Map();
    for (const source of document.sources) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(source.id) || this.#sources.has(source.id)) {
        throw new Error('Source IDs must be unique lowercase identifiers');
      }
      const text = boundedText(source.text, 'source text', 131072);
      if (digest(text) !== source.sha256) throw new Error(`Source hash mismatch: ${source.id}`);
      if (!/^\d{4}-\d{2}-\d{2}T/.test(source.retrievedAt) || !Number.isFinite(Date.parse(source.retrievedAt))) {
        throw new Error(`Invalid retrieval date: ${source.id}`);
      }
      this.#sources.set(source.id, Object.freeze({
        id: source.id, title: boundedText(source.title, 'title', 300),
        locator: boundedText(source.locator, 'locator', 2000),
        retrievedAt: source.retrievedAt, sha256: source.sha256, text,
      }));
    }
  }
  static async open(path) {
    const bytes = await readFile(path);
    if (bytes.length > 10 * 1024 * 1024) throw new Error('Catalog exceeds 10 MiB');
    return new Catalog(JSON.parse(bytes.toString('utf8')));
  }
  list() {
    return [...this.#sources.values()].map(({ text, ...metadata }) => ({
      ...metadata, lines: text.split('\n').length,
    }));
  }
  has(id) { return this.#sources.has(id); }
  with(source) {
    const existing = this.#sources.get(source.id);
    if (existing && existing.sha256 !== source.sha256) throw new Error('A source ID cannot silently change content');
    return new Catalog({ version: 1, sources: [...this.#sources.values()].filter(item => item.id !== source.id).concat(source) });
  }
  #range(id, start, end) {
    const source = this.#sources.get(id);
    if (!source) throw briefValidation('SOURCE_UNKNOWN', 'sourceId');
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start >= 80) {
      throw briefValidation('LINE_RANGE', 'lines');
    }
    const lines = source.text.split('\n');
    if (start > lines.length) throw briefValidation('LINE_START', 'lines');
    const passage = lines.slice(start - 1, end).join('\n');
    const { text, ...metadata } = source;
    return { ...metadata, start, end: Math.min(end, lines.length), passage, trusted: false };
  }
  read(id, start = 1, end = start + 39, offset = 0) {
    const range = this.#range(id, start, end);
    const { passage } = range;
    if (!Number.isSafeInteger(offset) || offset < 0 || (offset > 0 && offset >= passage.length) ||
        splitsSurrogatePair(passage, offset)) {
      throw briefValidation('PASSAGE_OFFSET', 'offset');
    }
    if (offset === 0 && passage.length <= pageSize) return range;
    let stop = Math.min(offset + pageSize, passage.length);
    if (splitsSurrogatePair(passage, stop)) stop--;
    return { ...range, passage: passage.slice(offset, stop), offset,
      ...(stop < passage.length ? { nextOffset: stop } : {}) };
  }
  citation(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw briefValidation('CITATION_OBJECT');
    const { sourceId, start, end, quote } = input;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) throw briefValidation('LINE_RANGE', 'lines');
    const passage = this.#range(sourceId, start, end);
    if (typeof quote !== 'string' || !quote.trim() || quote.length > 1000) throw briefValidation('TEXT_1000', 'quote');
    if (quote.trim().split(/\s+/u).length > 25) throw briefValidation('QUOTE_WORDS', 'quote');
    // A model can render a Windows newline as LF. Store the exact source substring.
    let sourceQuote = quote;
    if (!passage.passage.includes(quote)) {
      if (!quote.includes('\n')) throw briefValidation('QUOTE_NOT_EXACT', 'quote');
      const pattern = quote.split(/\r?\n/).map(RegExp.escape).join('\\r?\\n');
      sourceQuote = new RegExp(pattern, 'u').exec(passage.passage)?.[0];
      if (!sourceQuote) throw briefValidation('QUOTE_NOT_EXACT', 'quote');
      if (sourceQuote.length > 1000) throw briefValidation('TEXT_1000', 'quote');
    }
    return {
      sourceId, start, end: passage.end, quote: sourceQuote, locator: passage.locator,
      sha256: passage.sha256, retrievedAt: passage.retrievedAt,
    };
  }
}

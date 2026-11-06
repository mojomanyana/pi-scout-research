import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

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
  read(id, start = 1, end = start + 39) {
    const source = this.#sources.get(id);
    if (!source) throw new Error('Source is not in the operator-approved catalog');
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start >= 80) {
      throw new Error('Read a range of 1â€“80 lines');
    }
    const lines = source.text.split('\n');
    if (start > lines.length) throw new Error('Start line is beyond the source');
    const passage = lines.slice(start - 1, end).join('\n');
    if (passage.length > 16000) throw new Error('Passage exceeds 16000 characters; request fewer lines');
    const { text, ...metadata } = source;
    return { ...metadata, start, end: Math.min(end, lines.length), passage, trusted: false };
  }
  citation({ sourceId, start, end, quote }) {
    const passage = this.read(sourceId, start, end);
    boundedText(quote, 'quote', 1000);
    if (quote.trim().split(/\s+/u).length > 25 || !passage.passage.includes(quote)) {
      throw new Error('Citation must be an exact excerpt of at most 25 words from the stated lines');
    }
    return {
      sourceId, start, end: passage.end, quote, locator: passage.locator,
      sha256: passage.sha256, retrievedAt: passage.retrievedAt,
    };
  }
}

import { readFile } from 'node:fs/promises';
import { boundedText, digest } from './catalog.mjs';

// A versioned adapter, not a search engine. Only the operator supplies destinations.
export class WebProfile {
  #sources;
  constructor(document) {
    if (document?.version !== 1 || document.adapter !== 'pi-web-access@0.38.0' ||
        !Array.isArray(document.sources) || document.sources.length > 64) {
      throw new Error('Expected a version 1 pi-web-access@0.38.0 profile with at most 64 sources');
    }
    const sources = document.sources.map(source => {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(source.id)) throw new Error('Invalid web source ID');
      const url = new URL(boundedText(source.url, 'approved URL', 2000));
      const loopbackFixture = document.allowLoopbackHttp === true && url.protocol === 'http:' && url.hostname === '127.0.0.1';
      if ((!loopbackFixture && url.protocol !== 'https:') || url.username || url.password || url.hash) {
        throw new Error('Approved URLs require HTTPS and no credentials or fragment; loopback HTTP needs explicit fixture permission');
      }
      return Object.freeze({ id: source.id, title: boundedText(source.title, 'source title', 300), url: url.href });
    });
    this.#sources = new Map(sources.map(source => [source.id, source]));
    if (this.#sources.size !== sources.length) throw new Error('Web source IDs must be unique');
  }
  static async open(path) {
    const bytes = await readFile(path);
    if (bytes.length > 256 * 1024) throw new Error('Web profile exceeds 256 KiB');
    return new WebProfile(JSON.parse(bytes.toString('utf8')));
  }
  list() { return [...this.#sources.values()]; }
  has(id) { return this.#sources.has(id); }
  allows(args) {
    return args && typeof args === 'object' && Object.keys(args).every(key => ['url', 'mode', 'auth'].includes(key)) &&
      args.mode === 'raw' && args.auth === false && this.list().some(source => source.url === args.url);
  }
  matches(source) { return source && this.#sources.get(source.id)?.url === source.locator; }
  async fetch(id, execute, signal) {
    const source = this.#sources.get(id);
    if (!source) throw new Error('Source is not in the operator-approved web profile');
    signal?.throwIfAborted();
    const execution = await execute('fetch_content', { url: source.url, mode: 'raw', auth: false }, { signal });
    signal?.throwIfAborted();
    if (execution.isError) throw new Error('Reference engine fetch failed; no source snapshot was accepted');
    const urls = execution.result?.structuredContent?.urls;
    if (!Array.isArray(urls) || urls.length !== 1) throw new Error('Reference engine returned an unsupported result shape');
    const page = urls[0];
    if (page.url !== source.url || page.error || (page.status !== undefined && (page.status < 200 || page.status >= 300))) {
      throw new Error('Reference engine did not return a successful result for the approved URL');
    }
    const text = boundedText(page.content, 'fetched source text', 131072);
    return { id, title: source.title, locator: source.url, retrievedAt: new Date().toISOString(), text, sha256: digest(text) };
  }
}

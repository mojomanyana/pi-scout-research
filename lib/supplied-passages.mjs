// Each retained passage is an exact substring. Offsets refer to the decoded
// source, while citation line numbers refer to the retained passage itself.
const common = new Set('the and are with for from that what this does source supplied official documentation using only pages'.split(' '));
export function selectPassages(text, question) {
  if (typeof text !== 'string' || text.length > 2 * 1024 * 1024 || Buffer.byteLength(text) > 2 * 1024 * 1024 || !text.trim()) return [];
  if (text.length <= 2400) return [{ offset: 0, text }];
  const terms = [...new Set(question.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])].filter(term => !common.has(term)).slice(0, 64);
  const windows = [];
  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + 1200, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf('\n', end - 1);
      if (boundary > start + 600) end = boundary + 1;
    }
    const body = text.slice(start, end).toLowerCase();
    windows.push({ start, end, hits: terms.filter(term => body.includes(term)) });
    start = end;
  }
  const frequencies = new Map();
  for (const { hits } of windows) for (const term of hits) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  for (const w of windows) w.score = w.hits.reduce((sum, term) => sum + Math.log1p(windows.length / frequencies.get(term)), 0);
  return windows.sort((a,b) => b.score - a.score || a.start - b.start).slice(0, 4)
    .sort((a,b) => a.start - b.start).map(w => {
      const offset = Math.max(0, w.start - 180);
      return { offset, text: text.slice(offset, w.end + 180) };
    }).filter(p => p.text.trim());
}

// Only compare an unambiguous requested release to an explicitly versioned
// locator. Never infer a document version from numbers inside sample code.
export function differentRelease(url, question) {
  const versions = value => [...new Set(Array.from(value.matchAll(/\bv?(\d+\.\d+\.\d+)\b/gi), m => m[1]))];
  const wanted = versions(question), supplied = versions(new URL(url).pathname);
  return wanted.length === 1 && supplied.length === 1 && wanted[0] !== supplied[0]
    ? `Requested release ${wanted[0]}, supplied locator identifies ${supplied[0]}.` : undefined;
}

export function suppliedModelBudget(bridge) {
  let calls = 0, exhausted = false;
  return {
    get calls() { return calls; },
    get exhausted() { return exhausted; },
    async request(context, signal) {
      signal?.throwIfAborted();
      if (calls >= 6) { exhausted = true; throw Error('Supplied-page model budget reached'); }
      calls++;
      return bridge.request(context, signal);
    },
  };
}

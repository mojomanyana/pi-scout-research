import { discoveryLeads } from './public-url.mjs';
import { scoutFailure } from './worker-failure.mjs';

const maxResponseBytes = 128 * 1024;

export function braveOrder(env) {
  // Preserve an explicitly configured legacy fallback or disable setting.
  if (env.PI_SCOUT_SEARCH_PROVIDER !== undefined) return env.PI_SCOUT_SEARCH_PROVIDER === 'brave' ? 'first' : 'off';
  if (env.PI_SCOUT_SEARCH_FALLBACK !== undefined) return env.PI_SCOUT_SEARCH_FALLBACK === 'brave' ? 'fallback' : 'off';
  return 'first';
}

export function dockerEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== 'BRAVE_API_KEY'));
}

// This closure lives only in the host. The worker can request the operator's
// original public question once. It cannot choose a query, URL, key or header.
export function braveDiscovery(request, { env, authorized, fetchImpl = fetch }) {
  const question = request.question.trim();
  if (request.mode !== 'public' || request.sourceUrls?.length ||
      braveOrder(env) === 'off' || !env.BRAVE_API_KEY?.trim() ||
      !question || [...question].length > 600 || question.split(/\s+/u).length > 75) return;
  const key = env.BRAVE_API_KEY.trim();
  let used = false;
  return async signal => {
    if (used) throw scoutFailure('SOURCE_SEARCH_FAILED');
    used = true;
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', question);
    url.searchParams.set('count', '5');
    try {
      if (!await authorized()) throw scoutFailure('SOURCE_SEARCH_FAILED');
      bounded.throwIfAborted();
      const response = await fetchImpl(url, { signal: bounded, redirect: 'error', credentials: 'omit',
        headers: { accept: 'application/json', 'X-Subscription-Token': key } });
      if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maxResponseBytes) {
        await response.body?.cancel();
        throw scoutFailure('SOURCE_SEARCH_FAILED');
      }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bounded.throwIfAborted();
        bytes += chunk.byteLength;
        if (bytes > maxResponseBytes) throw scoutFailure('SOURCE_LIMIT');
        chunks.push(chunk);
      }
      const rows = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))?.web?.results;
      if (!Array.isArray(rows)) throw scoutFailure('SOURCE_RESULT_INVALID');
      const results = discoveryLeads(rows, 'description', key);
      if (!results.length || !await authorized()) throw scoutFailure('SOURCE_SEARCH_FAILED');
      bounded.throwIfAborted();
      return results;
    } catch {
      // Never relay provider bodies, credentials, queries, URLs or network errors.
      throw scoutFailure('SOURCE_SEARCH_FAILED');
    }
  };
}

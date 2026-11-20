// URL validation does not endorse a publisher or enforce Docker's network egress.
const invalid = message => Object.assign(new Error(message), { code: 'SOURCE_URLS_INVALID' });
export function publicUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000 || value !== value.trim() || /[\x00-\x20\x7f]/.test(value)) {
    throw invalid('Use an exact public HTTPS URL of at most 2000 characters');
  }
  let url;
  try { url = new URL(value); }
  catch { throw invalid('Use a valid public HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw invalid('Use a public HTTPS URL without credentials or a fragment');
  }
  if (url.href.length > 2000) throw invalid('The normalized public URL must fit within 2000 characters');
  return url.href;
}

export function sourceUrls(value, mode) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 6) throw invalid('Provide at most six known public source URLs');
  if (mode !== 'public' && value.length) throw invalid('Direct public source URLs require public research mode');
  const urls = value.map(publicUrl);
  if (new Set(urls).size !== urls.length) throw invalid('Provide distinct public source URLs');
  return urls;
}

// Providers frequently return a section anchor. Fetching that link retrieves
// the same page bytes, so deduplicate and cite the fragment-free document URL.
function discoveryUrl(value) {
  if (typeof value !== 'string') return;
  try { return publicUrl(value.split('#', 1)[0]); }
  catch { return; }
}

export function discoveryLeads(rows, snippetField, privateValue) {
  const results = [];
  const seen = new Set();
  for (const row of rows) {
    const url = discoveryUrl(row?.url);
    if (!url || seen.has(url)) continue;
    const title = typeof row.title === 'string' ? row.title : url;
    const snippet = typeof row[snippetField] === 'string' ? row[snippetField] : '';
    // An error-shaped response can reflect an authorization header as a result.
    if (privateValue && [url, title, snippet].some(value => value.includes(privateValue))) continue;
    seen.add(url);
    results.push({ url, title: title.slice(0, 300), snippet: snippet.slice(0, 400) });
    if (results.length === 5) break;
  }
  return results;
}

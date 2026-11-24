/**
 * Opt-in host-side direct HTTPS fetch for explicitly user-supplied official docs URLs
 * when Docker is unavailable (`scout.directUrls: true` in ecosystem.json or PI_SCOUT_DIRECT_URLS=1).
 *
 * Strict security controls:
 * - Only explicitly supplied HTTPS URLs (never open-ended web search/crawling).
 * - DNS pre-check blocks loopback, RFC1918 private, link-local, multicast, and IPv6 ULA/loopback ranges.
 * - No cookies, no credentials, redirect: 'error' (prevents redirect-to-private-IP SSRF), 15s timeout, 2 MiB max.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { publicUrl } from './public-url.mjs';
import { selectPassages } from './supplied-passages.mjs';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

export function isPrivateOrReservedIp(ip) {
  const version = isIP(ip);
  if (version === 4) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('::ffff:')) return isPrivateOrReservedIp(lower.slice(7));
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // link-local
    if (lower.startsWith('ff')) return true; // multicast
    return false;
  }
  return true;
}

export async function assertSafePublicUrl(rawUrl, dnsLookup = lookup) {
  const normalized = publicUrl(rawUrl);
  const parsed = new URL(normalized);
  if (parsed.protocol !== 'https:') throw new Error('Direct fetch allows HTTPS URLs only');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error(`Direct fetch refused private host: ${host}`);
  }
  if (isIP(host)) {
    if (isPrivateOrReservedIp(host)) throw new Error(`Direct fetch refused private IP: ${host}`);
    return normalized;
  }
  const records = await dnsLookup(host, { all: true });
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`Direct fetch could not resolve host: ${host}`);
  }
  for (const rec of records) {
    if (isPrivateOrReservedIp(rec.address)) {
      throw new Error(`Direct fetch refused private resolved IP for ${host}`);
    }
  }
  return normalized;
}

export function stripHtmlToText(raw) {
  return String(raw)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function fetchPublicOfficialPages({ question, scope, sourceUrls, signal, fetchImpl = fetch, dnsLookup = lookup }) {
  const urls = [...sourceUrls].slice(0, 6);
  const results = await Promise.all(
    urls.map(async (rawUrl) => {
      try {
        const safeUrl = await assertSafePublicUrl(rawUrl, dnsLookup);
        const deadline = AbortSignal.timeout(TIMEOUT_MS);
        const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
        const res = await fetchImpl(safeUrl, {
          method: 'GET',
          redirect: 'error',
          credentials: 'omit',
          headers: { accept: 'text/plain, text/markdown, text/html;q=0.9', 'user-agent': 'pi-scout-research/1.0' },
          signal: combined,
        });
        if (!res.ok) return { url: safeUrl, error: `HTTP ${res.status}` };
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_BODY_BYTES) return { url: safeUrl, error: 'Page exceeded 2 MiB limit' };
        const rawText = buf.toString('utf8');
        const ctype = (res.headers?.get?.('content-type') ?? '').toLowerCase();
        const text = ctype.includes('html') || /^\s*</.test(rawText) ? stripHtmlToText(rawText) : rawText;
        const passages = selectPassages(text, `${question} ${scope}`);
        return { url: safeUrl, passages: passages.slice(0, 4) };
      } catch (err) {
        return { url: rawUrl, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  return results;
}

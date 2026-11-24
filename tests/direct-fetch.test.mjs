import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafePublicUrl, fetchPublicOfficialPages, isPrivateOrReservedIp, stripHtmlToText } from '../lib/direct-fetch.mjs';

test('isPrivateOrReservedIp blocks loopback, RFC1918, link-local, and IPv6 ULA', () => {
  for (const bad of ['127.0.0.1', '10.0.0.5', '172.16.1.1', '192.168.1.1', '169.254.169.254', '::1', 'fc00::1', 'fe80::1']) {
    assert.equal(isPrivateOrReservedIp(bad), true, bad);
  }
  assert.equal(isPrivateOrReservedIp('93.184.216.34'), false);
  assert.equal(isPrivateOrReservedIp('2606:2800:220:1:248:1893:25c8:1946'), false);
});

test('assertSafePublicUrl blocks localhost, HTTP, and DNS resolving to private IPs', async () => {
  await assert.rejects(() => assertSafePublicUrl('http://example.com/docs'));
  await assert.rejects(() => assertSafePublicUrl('https://localhost/secret'));
  await assert.rejects(() => assertSafePublicUrl('https://rebind.example.com/', async () => [{ address: '127.0.0.1', family: 4 }]));
  const ok = await assertSafePublicUrl('https://nodejs.org/api/sqlite.html', async () => [{ address: '104.20.23.46', family: 4 }]);
  assert.equal(ok, 'https://nodejs.org/api/sqlite.html');
});

test('fetchPublicOfficialPages strips HTML and extracts relevant passages without Docker', async () => {
  const html = '<html><body><script>evil()</script><h1>Node SQLite</h1><p>DatabaseSync supports synchronous FTS5 queries in Node 24.</p></body></html>';
  assert.doesNotMatch(stripHtmlToText(html), /evil/);
  const pages = await fetchPublicOfficialPages({
    question: 'Does Node 24 DatabaseSync support FTS5?',
    scope: 'node:sqlite',
    sourceUrls: ['https://nodejs.org/api/sqlite.html'],
    dnsLookup: async () => [{ address: '104.20.23.46', family: 4 }],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      arrayBuffer: async () => Buffer.from(html),
    }),
  });
  assert.equal(pages.length, 1);
  assert.equal(pages[0].error, undefined);
  assert.ok(pages[0].passages.length >= 1);
  assert.match(pages[0].passages[0].text, /DatabaseSync/);
});

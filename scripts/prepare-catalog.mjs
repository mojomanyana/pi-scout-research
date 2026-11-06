#!/usr/bin/env node
import { readFile, open, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Catalog, digest } from '../lib/catalog.mjs';

const [manifestPath, outputPath, ...extra] = process.argv.slice(2);
if (!manifestPath || !outputPath || extra.length) {
  console.error('Usage: scout-catalog <approved-local-sources.json> <new-catalog.json>');
  process.exit(2);
}
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (!Array.isArray(manifest) || manifest.length > 64) throw new Error('Expected at most 64 operator-selected local sources');
const sources = [];
for (const input of manifest) {
  if (typeof input.path !== 'string' || !input.path) throw new Error('Each source needs an explicit local path');
  const path = resolve(dirname(resolve(manifestPath)), input.path);
  const info = await stat(path);
  if (!info.isFile() || info.size > 131072) throw new Error('Each source must be a regular UTF-8 text file of at most 128 KiB');
  const bytes = await readFile(path);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  sources.push({ id: input.id, title: input.title, locator: input.locator ?? path,
    retrievedAt: new Date().toISOString(), text, sha256: digest(text) });
}
const document = { version: 1, sources };
new Catalog(document);
const file = await open(outputPath, 'wx', 0o600);
try { await file.writeFile(JSON.stringify(document, null, 2) + '\n'); await file.sync(); }
finally { await file.close(); }
console.log(JSON.stringify({ saved: resolve(outputPath), sources: sources.length, networkRequests: 0 }));

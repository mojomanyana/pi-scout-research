import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('documented skill commands refer to registered Pi skills', async () => {
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const readme = await readFile(new URL('README.md', root), 'utf8');
  const commands = [...readme.matchAll(/\/skill:([\w-]+)/g)].map(match => match[1]);
  const names = new Set();
  for (const directory of manifest.pi.skills) {
    const relative = directory.replace(/^\.\//, '');
    const skill = await readFile(new URL(`${relative}/SKILL.md`, root), 'utf8');
    names.add(/^name:\s*(\S+)\s*$/m.exec(skill)?.[1]);
  }
  for (const name of commands) assert.ok(names.has(name), `Unavailable installed skill: ${name}`);
});

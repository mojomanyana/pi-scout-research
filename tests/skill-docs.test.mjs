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

test('package ships and registers scout-public skill definition for Pi Daddy delegation', async () => {
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.ok(manifest.files.includes('scout-public'), 'scout-public must be included in published files');
  assert.ok(manifest.pi.skills.includes('./scout-public'), 'scout-public must be registered in pi.skills');
  const skill = await readFile(new URL('scout-public/SKILL.md', root), 'utf8');
  assert.match(skill, /^name:\s*scout-public\s*$/m);
  assert.match(skill, /^allowed-tools:\s*scout_research\s*$/m);
});

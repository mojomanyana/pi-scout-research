import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, cp, mkdtemp, symlink, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
const daddy = process.env.SCOUT_DADDY_ROOT;
test('native Daddy parses Scout as a narrow optional definition with only the research capability',
  { skip: (!daddy || !process.env.SCOUT_PI_SDK_ROOT) && 'Set installed Pi Daddy and SDK roots' }, async t => {
    // Pi-managed installs omit peers; supply the actual installed SDK in an isolated copy.
    const root = await mkdtemp(join(tmpdir(), 'scout-daddy-parser-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await cp(join(daddy, 'dist'), join(root, 'package/dist'), { recursive: true });
    await cp(join(daddy, 'package.json'), join(root, 'package/package.json'));
    await symlink(resolve(process.env.SCOUT_PI_SDK_ROOT, '../..'), join(root, 'node_modules'), 'dir');
    const { parseSkillDefinition, ceilingForDefinition } = await import(pathToFileURL(resolve(root, 'package/dist/kernel/definitions.js')));
    const { makeCatalog, classifyToolNames, definitionEntries, unknownCapabilities } = await import(pathToFileURL(resolve(root, 'package/dist/kernel/catalog.js')));
    const path = fileURLToPath(new URL('../scout-public/SKILL.md', import.meta.url));
    const definition = parseSkillDefinition(path, await readFile(path, 'utf8'));
    assert.equal(definition.name, 'scout-public');
    assert.deepEqual(ceilingForDefinition(definition), { capabilities: ['tool:scout_research'], patterns: [], undeclared: false });
    const catalog = makeCatalog([...classifyToolNames(['scout_research']), ...definitionEntries(new Map([[definition.name, definition]]))]);
    assert.ok(catalog.has('agent:scout-public'));
    assert.deepEqual(unknownCapabilities(['tool:scout_research'], catalog), []);
    assert.deepEqual(unknownCapabilities(['tool:bash'], catalog), ['tool:bash']);
  });

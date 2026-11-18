import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, cp, mkdtemp, symlink, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
const daddy = process.env.SCOUT_DADDY_ROOT;
const roots = (!daddy || !process.env.SCOUT_PI_SDK_ROOT) && 'Set installed Pi Daddy and SDK roots';
// Pi-managed installs omit peers; supply the actual installed SDK in an isolated copy.
async function isolatedDaddy(t) {
  const root = await mkdtemp(join(tmpdir(), 'scout-daddy-parser-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(daddy, 'dist'), join(root, 'package/dist'), { recursive: true });
  await cp(join(daddy, 'package.json'), join(root, 'package/package.json'));
  await symlink(resolve(process.env.SCOUT_PI_SDK_ROOT, '../..'), join(root, 'node_modules'), 'dir');
  return root;
}
test('native Daddy parses Scout as a narrow optional definition with only the research capability',
  { skip: roots }, async t => {
    const root = await isolatedDaddy(t);
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

// A parent catalog entry is not child delivery. README.md and scout-public/SKILL.md say scout_research
// stays in the parent session because Daddy refuses to deliver it to a governed child. This asks the
// installed Daddy's own planner rule, so the suite fails the day those documents and the sibling package
// disagree again. When child delivery is actually built, flip this assertion and the documents together.
const childTools = daddy && join(daddy, 'dist/kernel/child-tools.js');
// Only a Daddy older than the rule may lack the module; a later one without it must fail here, not skip.
const predatesRule = () => {
  if (existsSync(childTools)) return false;
  try {
    const [major, minor] = JSON.parse(readFileSync(join(daddy, 'package.json'), 'utf8')).version.split('.').map(Number);
    return major === 0 && minor < 57;
  } catch { return false; }
};
test('installed Daddy refuses to deliver scout_research to a governed child, so documented use stays in the parent',
  { skip: roots || (predatesRule() && 'Installed Pi Daddy predates its child tool delivery rule (0.57.0)') }, async t => {
    assert.ok(existsSync(childTools), 'Pi Daddy 0.57.0 or later without dist/kernel/child-tools.js: recheck child delivery and the README');
    const root = await isolatedDaddy(t);
    const { parseSkillDefinition, ceilingForDefinition } = await import(pathToFileURL(resolve(root, 'package/dist/kernel/definitions.js')));
    const { childToolDeliveryRefusal } = await import(pathToFileURL(resolve(root, 'package/dist/kernel/child-tools.js')));
    const path = fileURLToPath(new URL('../scout-public/SKILL.md', import.meta.url));
    const requested = ceilingForDefinition(parseSkillDefinition(path, await readFile(path, 'utf8'))).capabilities;
    assert.deepEqual(requested, ['tool:scout_research']);
    // The parent's live tool inventory as Daddy snapshots it: native Pi tools, plus Scout's from its package extension.
    const childToolSources = [
      ...['read', 'bash'].map(name => ({ name, sourceInfo: { path: `builtin:${name}`, source: 'builtin' } })),
      { name: 'scout_research', sourceInfo: { path: fileURLToPath(new URL('../extension/worker.ts', import.meta.url)), source: 'npm:pi-scout-research' } }];
    const refused = childToolDeliveryRefusal(requested, { childToolSources });
    assert.equal(refused?.code, 'UNKNOWN_TOOL');
    assert.deepEqual(refused.details, { kind: 'child-tool-unavailable', tools: 'scout_research' });
    assert.match(refused.message, /child tool unavailable: scout_research/);
    assert.equal(childToolDeliveryRefusal(['tool:read'], { childToolSources }), undefined);
  });

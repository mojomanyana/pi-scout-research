import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseResearchModel } from '../lib/research-model.mjs';
const current = { provider: 'codex', id: 'sol' }, local = { provider: 'local', id: 'vendor/name' };
const registry = {find: (p,id) => p === local.provider && id === local.id ? local : undefined, getAvailable: () => [current,local], hasConfiguredAuth: () => true};
const ctx = { model: current, modelRegistry: registry };
test('session wins over unavailable FAST, saved selection beats a legacy override', async () => {
  assert.deepEqual(await chooseResearchModel(ctx,'medium',{models:{fast:'fireworks/unavailable'}},{}),{model:current,thinking:'low'});
  assert.deepEqual(await chooseResearchModel(ctx,'medium',{scout:{model:'local/vendor/name',thinking:'off'}},{PI_SCOUT_MODEL:'old/missing'}),{model:local,thinking:'off'});
});
test('unavailable model offers a replacement for this request, cancellation gives an actionable error',async () => {
  const cfg = {scout:{model:'lost/model'}};
  const pick = (answer) => ({...ctx,hasUI:true,ui:{select:async (_,ids)=>{assert.deepEqual(ids,['codex/sol','local/vendor/name']);return answer}}});
  assert.equal((await chooseResearchModel(pick('codex/sol'),'off',cfg,{})).model,current);
  await assert.rejects(chooseResearchModel(pick(undefined),'off',cfg,{}),/Settings/);
  await assert.rejects(chooseResearchModel(ctx,'off',cfg,{}),/login/);
});

test('a configured model whose credentials cannot resolve prompts before dispatch',async () => {
  let prompts=0;
  const modelRegistry = {...registry,getApiKeyAndHeaders:async m=>({ok:m===local})};
  const ui={select:async (_,options)=>{prompts++;assert.deepEqual(options,['local/vendor/name']);return options[0]}};
  const choice=await chooseResearchModel({...ctx,modelRegistry,ui,hasUI:true},'low',{},{});
  assert.equal(choice.model,local); assert.equal(prompts,1);
});

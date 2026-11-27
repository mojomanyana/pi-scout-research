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

test('empty/whitespace config values fall back cleanly and null config/env do not throw', async () => {
  assert.deepEqual(await chooseResearchModel(ctx, 'medium', { scout: { model: '  ', thinking: '' } }, {}), { model: current, thinking: 'low' });
  assert.deepEqual(await chooseResearchModel(ctx, 'off', null, null), { model: current, thinking: 'off' });
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(chooseResearchModel(ctx, 'low', {}, {}, aborted.signal));
});

test('failed replacement selection names the chosen replacement model', async () => {
  const modelRegistry = { ...registry, getApiKeyAndHeaders: async () => ({ ok: false }) };
  const ui = { select: async () => 'local/vendor/name' };
  await assert.rejects(
    chooseResearchModel({ ...ctx, modelRegistry, hasUI: true, ui }, 'low', { scout: { model: 'lost/model' } }, {}),
    /Selected Scout replacement model local\/vendor\/name is unavailable/,
  );
});

test('aborting an open replacement picker dismisses it and releases the request', async () => {
  const controller = new AbortController();
  const opened = Promise.withResolvers();
  const ui = { select: (_title, _choices, options) => {
    assert.equal(options?.signal, controller.signal);
    opened.resolve();
    return new Promise(resolve => options.signal.addEventListener('abort', () => resolve(undefined), {once: true}));
  }};
  const request = chooseResearchModel({...ctx, hasUI:true, ui}, 'low', {scout:{model:'lost/model'}}, {}, controller.signal);
  await Promise.race([opened.promise, request]);
  controller.abort();
  await assert.rejects(request, {name:'AbortError'});
  assert.equal((await chooseResearchModel(ctx, 'low')).model, current);
});

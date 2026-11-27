import { saveScoutModelDefault } from './ecosystem-config.mjs';

/** Resolve before worker admission so an interactive replacement can continue the same request. */
export async function chooseResearchModel(ctx, parentThinking, config = {}, env = {}, signal) {
  signal?.throwIfAborted();
  const cfgModel = typeof config?.scout?.model === 'string' ? config.scout.model.trim() : '';
  const preference = cfgModel || env?.PI_SCOUT_MODEL?.trim() || 'session';
  const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const cfgThinking = typeof config?.scout?.thinking === 'string' ? config.scout.thinking.trim() : '';
  const level = cfgThinking || env?.PI_SCOUT_THINKING?.trim() || 'auto';
  if (level !== 'auto' && !levels.includes(level)) throw Error('Choose a supported Scout thinking level in Settings.');
  const thinking = level === 'auto' ? (parentThinking === 'off' ? 'off' : 'low') : level;
  const registry = ctx.modelRegistry;
  const id = (m) => m.provider + '/' + m.id;
  const split = typeof preference === 'string' && preference.match(/^([^/:\s]+)[/:](.+)$/);
  const model = preference === 'session' ? ctx.model : split && registry?.find?.(split[1], split[2]);
  const usable = async candidate => {
    if (!candidate || registry?.hasConfiguredAuth?.(candidate) === false) return false;
    if (!registry?.getApiKeyAndHeaders) return true;
    try { return (await registry.getApiKeyAndHeaders(candidate))?.ok === true; }
    catch { return false; }
  };
  if (await usable(model)) {
    signal?.throwIfAborted();
    return { model, thinking };
  }
  signal?.throwIfAborted();
  const message = 'Scout model ' + preference + ' is unavailable. Use /login to connect a provider or choose a research model in Settings.';
  const available = (registry?.getAvailable?.() ?? []).filter(candidate => !model || id(candidate) !== id(model));
  if (ctx.hasUI && typeof ctx.ui?.select === 'function' && available.length) {
    const sessionUsable = preference !== 'session' && (await usable(ctx.model));
    const useOnceOption = sessionUsable ? `Use session model once (${id(ctx.model)})` : null;
    const chooseDefaultOption = preference !== 'session' ? 'Choose a new default' : null;
    if (useOnceOption || chooseDefaultOption) {
      const actions = [...(useOnceOption ? [useOnceOption] : []), ...(chooseDefaultOption ? [chooseDefaultOption] : [])];
      const choice = await ctx.ui.select(
        `Scout research could not use configured model ${preference}. Choose recovery action:`,
        actions,
        { signal },
      );
      signal?.throwIfAborted();
      if (choice === useOnceOption && ctx.model) {
        return { model: ctx.model, thinking, recovered: 'once' };
      }
      if (choice === chooseDefaultOption) {
        const picked = await ctx.ui.select(
          'Choose a new default Scout research model from compatible configured models:',
          available.map(id),
          { signal },
        );
        signal?.throwIfAborted();
        if (picked !== undefined) {
          const replacement = available.find(m => id(m) === picked);
          if (await usable(replacement)) {
            signal?.throwIfAborted();
            try { saveScoutModelDefault(picked, env ?? process.env); } catch { /* Best-effort persistence when env dir is read-only. */ }
            return { model: replacement, thinking, recovered: 'default', savedDefault: picked };
          }
          throw Error('Selected Scout replacement model ' + picked + ' is unavailable. Use /login to connect a provider or choose another model in Settings.');
        }
      }
      // Fallback for callers/fixtures that respond directly with a model id from the list.
      const direct = choice !== undefined ? available.find(m => id(m) === choice) : undefined;
      if (direct && (await usable(direct))) {
        signal?.throwIfAborted();
        return { model: direct, thinking, recovered: 'once' };
      }
      if (choice !== undefined && choice !== chooseDefaultOption) {
        throw Error('Selected Scout replacement model ' + choice + ' is unavailable. Use /login to connect a provider or choose another model in Settings.');
      }
      throw Error(message);
    }
    const selected = await ctx.ui.select(message + ' Choose a model for this request.', available.map(id), { signal });
    signal?.throwIfAborted();
    if (selected !== undefined) {
      const replacement = available.find(m => id(m) === selected);
      if (await usable(replacement)) {
        signal?.throwIfAborted();
        return { model: replacement, thinking, recovered: 'once' };
      }
      throw Error('Selected Scout replacement model ' + selected + ' is unavailable. Use /login to connect a provider or choose another model in Settings.');
    }
  }
  throw Error(message);
}

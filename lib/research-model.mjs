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
    const selected = await ctx.ui.select(message + ' Choose a model for this request.', available.map(id), { signal });
    signal?.throwIfAborted();
    if (selected !== undefined) {
      const replacement = available.find(m => id(m) === selected);
      if (await usable(replacement)) {
        signal?.throwIfAborted();
        return { model: replacement, thinking };
      }
      throw Error('Selected Scout replacement model ' + selected + ' is unavailable. Use /login to connect a provider or choose another model in Settings.');
    }
  }
  throw Error(message);
}

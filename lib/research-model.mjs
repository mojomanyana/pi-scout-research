/** Resolve before worker admission so an interactive replacement can continue the same request. */
export async function chooseResearchModel(ctx, parentThinking, config, env) {
  const preference = config.scout?.model ?? (env.PI_SCOUT_MODEL?.trim() || 'session');
  const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const level = config.scout?.thinking ?? (env.PI_SCOUT_THINKING?.trim() || 'auto');
  if (level !== 'auto' && !levels.includes(level)) throw Error('Choose a supported Scout thinking level in Settings.');
  const thinking = level === 'auto' ? (parentThinking === 'off' ? 'off' : 'low') : level;
  const registry = ctx.modelRegistry;
  const id = (m) => m.provider + '/' + m.id;
  const split = typeof preference === 'string' && preference.match(/^([^/:\s]+)[/:](.+)$/);
  const model = preference === 'session' ? ctx.model : split && registry.find?.(split[1], split[2]);
  const usable = async candidate => {
    if (!candidate || registry.hasConfiguredAuth?.(candidate) === false) return false;
    if (!registry.getApiKeyAndHeaders) return true;
    try { return (await registry.getApiKeyAndHeaders(candidate))?.ok === true; }
    catch { return false; }
  };
  if (await usable(model)) return { model, thinking };
  const message = 'Scout model ' + preference + ' is unavailable. Use /login to connect a provider or choose a research model in Settings.';
  const available = (registry.getAvailable?.() ?? []).filter(candidate => !model || id(candidate) !== id(model));
  if (ctx.hasUI && available.length) {
    const selected = await ctx.ui.select(message + ' Choose a model for this request.', available.map(id));
    const replacement = available.find(m => id(m) === selected);
    if (await usable(replacement)) return { model: replacement, thinking };
  }
  throw Error(message);
}

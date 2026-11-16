// Count provider responses once in the host; worker/session totals are a separate
// observation of the same calls, never additional usage to add to these totals.
const fields = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'];
const integer = value => Number.isSafeInteger(value) && value >= 0;

export function createUsageTracker() {
  let started = 0, settled = 0, measured = 0;
  const tokens = Object.fromEntries(fields.map(field => [field, 0]));
  return {
    start() {
      started++;
      let finished = false;
      return message => {
        if (finished) return;
        finished = true; settled++;
        const usage = message?.usage;
        if (!usage || fields.some(field => !integer(usage[field]) || !integer(tokens[field] + usage[field]))) return;
        measured++;
        for (const field of fields) tokens[field] += usage[field];
      };
    },
    snapshot() {
      return { source: 'host-provider-responses', calls: { started, settled, measured,
        unmeasured: settled - measured, pending: started - settled }, tokens: { ...tokens },
      coverage: measured === started && settled === started ? 'complete' : (measured ? 'partial' : 'unavailable') };
    },
  };
}

// Receipts admit only counters, never model/provider strings, cost or response bodies.
export function usageReceipt(value) {
  const calls = value?.calls, tokens = value?.tokens;
  if (!calls || !tokens || ['started', 'settled', 'measured', 'unmeasured', 'pending'].some(field => !integer(calls[field])) ||
      fields.some(field => !integer(tokens[field])) || calls.started !== calls.settled + calls.pending ||
      calls.settled !== calls.measured + calls.unmeasured) return undefined;
  return { source: 'host-provider-responses', calls: Object.fromEntries(
    ['started', 'settled', 'measured', 'unmeasured', 'pending'].map(field => [field, calls[field]])),
  tokens: Object.fromEntries(fields.map(field => [field, tokens[field]])),
  coverage: calls.measured === calls.started && calls.settled === calls.started ? 'complete' : (calls.measured ? 'partial' : 'unavailable') };
}

export function usageText(value) {
  const usage = usageReceipt(value);
  if (!usage) return '';
  if (!usage.calls.started) return 'Scout model usage: no model calls started.';
  const missing = usage.calls.unmeasured + usage.calls.pending;
  return `Scout model usage: ${usage.calls.started} calls started; ${usage.tokens.totalTokens} reported tokens from ${usage.calls.measured} measured responses${missing ? `; ${missing} calls have no recorded usage` : ''}. Token totals include reported cache usage; they are not billed cost or speed measurements.`;
}

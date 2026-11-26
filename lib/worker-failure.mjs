import { usageReceipt, usageText } from './worker-usage.mjs';
// Diagnostics are selected from this static vocabulary, never from error text.
const definitions = {
  WORKER_INITIALIZATION: ['setup', 'initializing', 'The research worker could not initialize.', 'Check the selected worker image and setup status.'],
  ENGINE_UNAVAILABLE: ['setup', 'loading-sources', 'The public research tools could not load.', 'Rebuild the worker from the installed Scout package and check its setup status.'],
  MODEL_REQUEST_FAILED: ['model', 'model-request', 'The selected Pi model request failed.', 'Choose a connected Scout model in /dashboard settings, or use /login and /model, then retry the research request.'],
  MODEL_RESPONSE_INVALID: ['model', 'model-response', 'The model returned an unsupported response.', 'Check the model/provider compatibility with Pi and Scout.'],
  MODEL_INCOMPLETE: ['model', 'model-response', 'The model stopped before completing the research.', 'Review the selected model and its limits before a deliberate retry.'],
  ANSWER_MISSING: ['result', 'finishing', 'Research ended without a final answer.', 'No completion is available; review the model choice before a deliberate retry.'],
  BRIEF_MISSING: ['evidence', 'finishing', 'Research ended without saving its required evidence brief.', 'Treat the research as incomplete; no sourced brief was delivered.'],
  BRIEF_INVALID: ['evidence', 'saving-brief', 'The research brief did not pass evidence validation.', 'Check that the brief cites sources actually retrieved by this worker.'],
  BRIEF_STORAGE_FAILED: ['storage', 'saving-brief', 'The research brief could not be saved.', 'Check available space and write access for Scout brief storage.'],
  SOURCE_SEARCH_FAILED: ['sources', 'searching', 'A public source search failed.', 'Check the public search service before a deliberate retry.'],
  SOURCE_FETCH_FAILED: ['sources', 'fetching', 'A public page could not be retrieved.', 'Check the requested public page or select another source.'],
  SOURCE_URLS_INVALID: ['input', 'selecting-sources', 'A direct source URL did not pass validation.', 'Use at most six distinct public HTTPS URLs, each at most 2000 characters after encoding, without credentials, spaces, control characters or fragments. Direct URLs require public mode.'],
  SOURCE_RESULT_INVALID: ['sources', 'reading-source', 'A source tool returned an unsupported result.', 'Check the worker public-tool version and its response format.'],
  SOURCE_LIMIT: ['sources', 'reading-source', 'A source exceeded the worker limits.', 'Use a smaller public source or a narrower passage.'],
  RESULT_INVALID: ['result', 'validating-result', 'The worker result did not pass validation.', 'No result was delivered; inspect Scout compatibility before a deliberate retry.'],
  WORKER_PROTOCOL: ['protocol', 'transport', 'The worker communication was invalid.', 'Check that the worker image matches the installed Scout package.'],
  WORKER_FAILED: ['unknown', 'unknown', 'Research did not complete; its cause was not classified.', 'Keep this failure record for diagnosis. It does not establish a source or provider outage.'],
  CATALOG_INVALID: ['configuration', 'loading-catalog', 'The optional worker catalog could not be read or validated.', 'Check PI_SCOUT_CATALOG: version 1, valid source entries, at most 1 MiB. Public research does not require a catalog.'],
  DOCKER_CLIENT: ['setup', 'checking-docker', 'The Docker client is unavailable.', 'Check Docker installation and WSL integration.'],
  DOCKER_UNAVAILABLE: ['setup', 'checking-docker', 'The Docker service is unavailable.', 'Start Docker and check the selected Docker connection.'],
  SETUP_BUILD: ['setup', 'building', 'The Scout worker image build failed.', 'Check Docker, network access and available disk space before a deliberate retry.'],
  SETUP_UNSETTLED: ['cleanup', 'settling', 'Worker setup did not settle.', 'Inspect Docker and setup state before starting another Scout session.'],
  CLEANUP_FAILED: ['cleanup', 'settling', 'Worker cleanup could not be confirmed.', 'Inspect the owned Scout container before starting another Scout session.'],
  CLIENT_UNSETTLED: ['cleanup', 'settling', 'A Docker client did not settle.', 'Inspect Docker client and container state before starting another Scout session.'],
  MODEL_CLIENT_UNSETTLED: ['cleanup', 'settling', 'The host model request did not settle.', 'Inspect the outstanding Pi model request before starting another Scout session.'],
  CANCELLED: ['cancelled', 'stopping', 'Research was cancelled.', 'No completed research brief was delivered.'],
  TIMEOUT: ['timeout', 'stopping', 'The research process reached its time limit.', 'Check worker and provider responsiveness before a deliberate retry.'],
  DOCKER_COMMAND: ['setup', 'docker', 'A Docker operation failed.', 'Check the selected Docker connection and worker setup.'],
  IMAGE_PROFILE: ['configuration', 'checking-image', 'The selected image does not match the Scout worker contract.', 'Select or rebuild the Scout worker image from the installed package.'],
  CONTAINER_PROFILE: ['configuration', 'checking-container', 'Docker did not apply the required worker isolation.', 'Check Docker support for the Scout worker profile.'],
  WORKER_EXIT: ['runtime', 'finishing', 'The worker exited without a complete valid result.', 'Check worker resource limits and setup; this alone does not identify the underlying cause.'],
  OUTPUT_LIMIT: ['protocol', 'transport', 'Cumulative worker output exceeded its size limit.', 'Inspect the recorded output counters and worker image version. This does not establish that the question itself was too long.'],
  FRAME_LIMIT: ['protocol', 'transport', 'One worker communication frame or reconstructed model context exceeded its size limit.', 'Inspect the recorded limit boundary. Use a smaller source passage or context within the same research scope; cumulative output is a separate limit.'],
  DOCKER_PLATFORM: ['configuration', 'checking-docker', 'The selected Docker engine does not run Linux containers.', 'Select a Linux-container Docker engine for Scout.'],
  SETUP_CONFIG: ['configuration', 'setup', 'Scout worker settings are invalid.', 'Check PI_SCOUT_WORKER_MODE and the selected Docker settings.'],
  SETUP_SOURCE: ['setup', 'building', 'The installed worker source is missing or invalid.', 'Reinstall Scout before building its worker.'],
  SETUP_IMAGE: ['configuration', 'checking-image', 'The selected Scout image is missing or invalid.', 'Restore the immutable image override or clear PI_SCOUT_WORKER_IMAGE to use automatic setup.'],
  SETUP_PATH: ['setup', 'building', 'The installed worker path could not be translated for Windows Docker.', 'Check WSL path translation and the Scout installation location.'],
  SETUP_BUSY: ['setup', 'waiting', 'Another Scout setup has not settled.', 'Check the existing setup process before starting another build.'],
  SETUP_LOCK_UNCERTAIN: ['cleanup', 'settling', 'Scout setup ownership could not be confirmed.', 'Inspect the setup cache and Docker before a deliberate retry.'],
  SETUP_LOCK_RELEASE: ['cleanup', 'settling', 'Scout could not release its setup ownership lock.', 'Inspect the setup cache before a deliberate retry.'],
  SETUP_SOURCE_CHANGED: ['setup', 'building', 'Scout changed during its worker build.', 'Let package installation finish before a deliberate retry.'],
};
const aliases = { CLIENT_MISSING: 'DOCKER_CLIENT', CLIENT_START: 'DOCKER_CLIENT', DOCKER_START: 'DOCKER_CLIENT',
  DOCKER_MISSING: 'DOCKER_CLIENT', SETUP_IMAGE_MISSING: 'SETUP_IMAGE',
  DOCKER_TIMEOUT: 'TIMEOUT', SETUP_TIMEOUT: 'TIMEOUT', SETUP_CANCELLED: 'CANCELLED',
  PROTOCOL: 'WORKER_PROTOCOL', WORKER_PIPE: 'WORKER_PROTOCOL', DOCKER_INSPECT: 'WORKER_PROTOCOL' };
const workerCodes = new Set(['WORKER_INITIALIZATION', 'ENGINE_UNAVAILABLE', 'MODEL_REQUEST_FAILED', 'MODEL_RESPONSE_INVALID',
  'MODEL_INCOMPLETE', 'ANSWER_MISSING', 'BRIEF_MISSING', 'BRIEF_INVALID', 'BRIEF_STORAGE_FAILED',
  'SOURCE_SEARCH_FAILED', 'SOURCE_FETCH_FAILED', 'SOURCE_RESULT_INVALID', 'SOURCE_LIMIT', 'RESULT_INVALID', 'WORKER_PROTOCOL', 'FRAME_LIMIT', 'WORKER_FAILED']);
const observationCodes = new Set(['SOURCE_SEARCH_FAILED', 'SOURCE_FETCH_FAILED', 'SOURCE_RESULT_INVALID', 'SOURCE_LIMIT', 'BRIEF_INVALID', 'BRIEF_STORAGE_FAILED']);
export function failureCode(error, fallback = 'WORKER_FAILED') {
  const code = error?.code;
  return Object.hasOwn(definitions, code) ? code : (Object.hasOwn(aliases, code) ? aliases[code] : fallback);
}
export function diagnostic(code) {
  const safe = failureCode({ code });
  const [category, stage, summary, nextStep] = definitions[safe];
  return { code: safe, category, stage, summary, nextStep };
}
export function observedFailures(values) {
  return Array.isArray(values) ? [...new Set(values.filter(code => observationCodes.has(code)))].slice(0, 6) : [];
}
export function scoutFailure(code, observations = []) {
  const safe = diagnostic(code);
  return Object.assign(new Error(safe.summary), { code: safe.code, observedFailures: observedFailures(observations) });
}
export function workerFailureFrame(requestId, error) {
  const code = failureCode(error);
  return { type: 'error', version: 1, requestId, code: workerCodes.has(code) ? code : 'WORKER_FAILED', observedFailures: observedFailures(error?.observedFailures) };
}
export function parseWorkerFailure(frame, requestId) {
  if (frame.version === undefined) {
    // Old explicitly selected images emitted arbitrary text. Never forward it.
    if (frame.requestId != null && frame.requestId !== requestId) throw scoutFailure('WORKER_PROTOCOL');
    return { code: 'WORKER_FAILED', observedFailures: [] };
  }
  if (frame.type !== 'error' || frame.version !== 1 || frame.requestId !== requestId || !workerCodes.has(frame.code) ||
      Object.keys(frame).some(key => !['type', 'version', 'requestId', 'code', 'observedFailures'].includes(key)) ||
      !Array.isArray(frame.observedFailures) || frame.observedFailures.length > 6 ||
      frame.observedFailures.some(code => !observationCodes.has(code)) || new Set(frame.observedFailures).size !== frame.observedFailures.length) {
    throw scoutFailure('WORKER_PROTOCOL');
  }
  return { code: frame.code, observedFailures: [...frame.observedFailures] };
}

// A safe receipt deliberately omits runtime command arguments and free text.
function transportReceipt(value) {
  if (!value || typeof value !== 'object') return undefined;
  const fields = ['stdoutBytes', 'stderrBytes', 'frames', 'modelRequests', 'deltaRequests', 'maxFrameBytes', 'frameLimitBytes', 'outputLimitBytes'];
  const counters = Object.fromEntries(fields.filter(key => Number.isSafeInteger(value[key]) && value[key] >= 0).map(key => [key, value[key]]));
  const limit = value.limit;
  if (limit && ['worker-output', 'worker-frame', 'host-frame', 'model-context'].includes(limit.kind) &&
      Number.isSafeInteger(limit.bytes) && limit.bytes >= 0 && Number.isSafeInteger(limit.limitBytes) && limit.limitBytes > 0) {
    counters.limit = { kind: limit.kind, bytes: limit.bytes, limitBytes: limit.limitBytes };
  }
  return Object.keys(counters).length ? counters : undefined;
}

export function failureReceipt(error, { requestId, phase, cleanupBlocked = false } = {}) {
  const runtime = error?.runtime;
  let code = failureCode(error);
  let origin = error?.code === 'WORKER_ERROR' && runtime?.failure?.origin === 'worker-reported' ? 'worker-reported' : 'host-observed';
  if (error?.code === 'WORKER_ERROR') code = failureCode(runtime?.failure);
  if (runtime?.cleanup?.confirmed === false) { code = 'CLEANUP_FAILED'; origin = 'host-observed'; }
  else if (runtime?.modelCallbackSettled === false) { code = 'MODEL_CLIENT_UNSETTLED'; origin = 'host-observed'; }
  else if (code === 'WORKER_FAILED' && phase === 'setup') code = 'WORKER_INITIALIZATION';
  const primary = diagnostic(code);
  const notStarted = phase === 'setup' && error?.code === 'DOCKER_UNAVAILABLE' &&
    runtime === undefined && !cleanupBlocked;
  const usage = usageReceipt(runtime?.usage), transport = transportReceipt(runtime?.transport);
  return { version: 1, ...(typeof requestId === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(requestId) ? { requestId } : {}),
    ...primary, origin,
    ...(notStarted ? { workerStarted: false,
      nextStep: 'Once the selected Docker connection is reachable, retry Scout through its normal tool within the authorized scope.' } : {}),
    observedFailures: observedFailures(runtime?.failure?.observedFailures ?? error?.observedFailures),
    cleanup: runtime?.cleanup?.confirmed === true ? 'confirmed' : (runtime?.cleanup?.confirmed === false ? 'unconfirmed' : 'unknown'),
    modelSettled: runtime?.modelCallbackSettled === true ? true : (runtime?.modelCallbackSettled === false ? false : null),
    furtherWorkBlocked: cleanupBlocked, ...(usage ? { usage } : {}), ...(transport ? { transport } : {}) };
}
export function failureText(receipt) {
  const related = receipt.observedFailures.length ? `\nEarlier tool failures: ${receipt.observedFailures.join(', ')}. These may have been recovered; they do not establish the cause.` : '';
  const cleanup = receipt.workerStarted === false
    ? 'Research worker not started; no worker cleanup needed for this attempt.'
    : `Worker cleanup: ${receipt.cleanup}.`;
  const usage = usageText(receipt.usage);
  const transport = receipt.transport;
  const traffic = transport && Number.isSafeInteger(transport.stdoutBytes) && Number.isSafeInteger(transport.stderrBytes)
    ? `\nWorker traffic: ${transport.stdoutBytes} stdout bytes; ${transport.stderrBytes} stderr bytes${transport.limit ? `; ${transport.limit.kind} limit ${transport.limit.limitBytes} bytes` : ''}.` : '';
  return `Scout: ${receipt.summary}\nNext: ${receipt.nextStep}\n${cleanup}${related}${traffic}${usage ? `\n${usage}` : ''}\nThe local source list is separate from this worker's research sources.`;
}

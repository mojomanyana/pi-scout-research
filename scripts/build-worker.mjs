#!/usr/bin/env node
import { prepareWorker } from '../lib/worker-setup.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(`Usage: scout-worker-build

Optionally prepare Scout's Docker worker ahead of the first research request.
Scout also does this automatically from Pi; no image exports are required.
Requires a running Docker daemon. Existing PI_SCOUT_* overrides are honored.
Does not launch Pi, research, or change Docker settings.`);
} else if (args.length) {
  console.error('Unexpected arguments. Usage: scout-worker-build [--help]');
  process.exitCode = 2;
} else {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Scout setup cancelled.'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const { image, mode } = await prepareWorker({ signal: controller.signal,
      onProgress: ({ stage }) => console.error(`Scout: ${stage}`) });
    console.log(`Scout worker ready (${mode}).\nImage: ${image}\nReturn to Pi and ask your research question. No environment exports are needed.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

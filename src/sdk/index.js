// ─────────────────────────────────────────────
// Sentinel SDK — Main entry point
// Unified API for browser integration
// ─────────────────────────────────────────────

import { Reporter } from './reporter.js';
import { Recorder } from './recorder.js';
import { Annotator } from './annotator.js';
import { Annotator as AnnotatorV2 } from './annotator.v2.js';

export { Reporter, Recorder, Annotator, AnnotatorV2 };

/**
 * Initialize Sentinel in one call.
 *
 * @example
 *   import { init } from '@nuptech/sentinel/sdk';
 *
 *   const sentinel = await init({
 *     serverUrl: 'http://localhost:3900',
 *     projectId: 'my-app',
 *     userId: 'tester@company.com',
 *   });
 *
 *   // When done:
 *   await sentinel.stop();
 */
export async function init({
  serverUrl,
  projectId,
  userId,
  apiKey,
  metadata,
  captureDOM = true,
  captureNetwork = true,
  captureConsole = true,
  captureErrors = true,
  sampling,
  annotator = true,
  annotatorPosition = 'bottom-right',
  annotatorVersion = 'v2',
  batchSize,
  flushInterval,
} = {}) {
  if (!serverUrl) throw new Error('Sentinel: serverUrl is required');
  if (!projectId) throw new Error('Sentinel: projectId is required');

  const reporter = new Reporter({ serverUrl, projectId, apiKey, batchSize, flushInterval });
  const session = await reporter.startSession({ userId, metadata });

  const recorder = new Recorder({
    reporter,
    captureDOM,
    captureNetwork,
    captureConsole,
    captureErrors,
    sampling,
  });
  await recorder.start();

  let annotatorInstance = null;
  if (annotator) {
    const AnnotatorClass = annotatorVersion === 'v2' ? AnnotatorV2 : Annotator;
    annotatorInstance = new AnnotatorClass({ reporter, recorder, position: annotatorPosition, serverUrl });
    annotatorInstance.mount();
  }

  // Cleanup on page unload
  const onBeforeUnload = () => reporter.destroy();
  window.addEventListener('beforeunload', onBeforeUnload);

  return {
    session,
    reporter,
    recorder,
    annotator: annotatorInstance,

    /** Report a finding programmatically */
    report: (finding) => reporter.reportFinding(finding),

    /** Stop recording, flush events, end session */
    async stop() {
      recorder.stop();
      if (annotatorInstance) annotatorInstance.unmount();
      window.removeEventListener('beforeunload', onBeforeUnload);
      await reporter.endSession();
    },
  };
}

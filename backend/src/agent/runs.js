import { makeId } from '../store.js';

/**
 * Registry of in-flight agent runs so the UI can cancel them (Stop button) and the
 * backend can clean up abort controllers when a client disconnects.
 */
export function createRunRegistry({ logger } = {}) {
  const runs = new Map();
  const log = logger || { debug() {} };

  function start({ sessionId, projectId, model, controller, kind = 'agent' }) {
    const runId = makeId('run');
    runs.set(runId, {
      runId,
      kind,
      sessionId,
      projectId,
      model,
      controller,
      startedAt: Date.now()
    });
    log.debug(`Run boshlandi: ${runId} (${kind})`);
    return runId;
  }

  function finish(runId) {
    const run = runs.get(runId);
    if (!run) return false;
    runs.delete(runId);
    return true;
  }

  const forget = finish;

  function stop(runId) {
    const run = runs.get(runId);
    if (!run) return false;
    try {
      run.controller.abort();
    } catch {
      /* already aborted */
    }
    runs.delete(runId);
    log.debug(`Run to‘xtatildi: ${runId}`);
    return true;
  }

  function stopBySession(sessionId) {
    let stopped = 0;
    for (const [runId, run] of [...runs.entries()]) {
      if (run.sessionId === sessionId) {
        if (stop(runId)) stopped += 1;
      }
    }
    return stopped;
  }

  function stopAll() {
    let stopped = 0;
    for (const runId of [...runs.keys()]) {
      if (stop(runId)) stopped += 1;
    }
    return stopped;
  }

  const get = (runId) => runs.get(runId) || null;
  const list = () => [...runs.values()].map(({ controller, ...rest }) => rest);

  return { start, finish, forget, stop, stopBySession, stopAll, get, list, count: () => runs.size };
}

export default createRunRegistry;

/**
 * Server-Sent Events helper. Every event is a single `data:` line containing JSON
 * with a `type` discriminator (see docs/ARCHITECTURE.md §14).
 *
 * Robustness rules learned the hard way:
 *  - a payload that cannot be serialised must be skipped, never kill the stream;
 *  - `close()` must always end the response, even if an earlier write failed,
 *    otherwise the client hangs until its own timeout.
 */
export function openSse(req, res, { pingMs = 15_000, onError } = {}) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let ended = false;
  let socketGone = false;
  const controller = new AbortController();

  const report = (message, error) => {
    if (typeof onError === 'function') {
      try {
        onError(message, error);
      } catch {
        /* ignore */
      }
    }
  };

  const send = (payload) => {
    if (ended || socketGone) return false;
    let frame;
    try {
      frame = `data: ${JSON.stringify(payload)}\n\n`;
    } catch (error) {
      report(`SSE payload serialise qilinmadi (${payload?.type || 'unknown'}): ${error.message}`);
      return false;
    }
    try {
      res.write(frame);
      return true;
    } catch (error) {
      socketGone = true;
      report(`SSE yozuv xatosi: ${error.message}`);
      return false;
    }
  };

  const ping = () => send({ type: 'ping', at: Date.now() });

  const timer = setInterval(ping, Math.max(2_000, pingMs));
  if (typeof timer.unref === 'function') timer.unref();
  ping();

  const close = () => {
    if (ended) return;
    ended = true;
    clearInterval(timer);
    try {
      res.end();
    } catch {
      /* the socket may already be gone */
    }
  };

  const onClose = () => {
    controller.abort();
    clearInterval(timer);
  };

  req.on('aborted', onClose);
  res.on('close', () => {
    ended = true;
    clearInterval(timer);
  });

  return {
    send,
    ping,
    close,
    get closed() {
      return ended;
    },
    signal: controller.signal,
    abort: () => controller.abort()
  };
}

export default openSse;

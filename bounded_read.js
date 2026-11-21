// Local browser budgets cover the reply, including body parsing. Expiry never
// determines whether a server operation was accepted.
export const SMALL_READ_TIMEOUT_MS = 5_000;
export const SHORT_ACK_TIMEOUT_MS = 10_000;

export function boundedRead(owner, read) {
  return waitForDelivery(owner, read, SMALL_READ_TIMEOUT_MS);
}

// Race the whole operation so a transport that ignores abort still settles
// for its caller. Without a deadline, only an explicit owner can stop waiting.
export async function waitForDelivery(owner, deliver, timeoutMs, observation) {
  const finish = (error, value, failed = false) => {
    try { observation?.finish(error, value, failed); } catch {}
  };
  try { owner?.throwIfAborted(); } catch (error) {
    try { observation?.stopped("owner", 0, undefined); } catch {}
    finish(error, undefined, true);
    throw error;
  }
  if (!owner && timeoutMs === undefined) {
    try {
      const result = await deliver(undefined);
      finish(undefined, result);
      return result;
    } catch (error) {
      finish(error, undefined, true);
      throw error;
    }
  }

  const controller = new AbortController();
  const started = (() => { try { return performance.now(); } catch { return 0; } })();
  const observedStop = source => {
    try {
      const elapsed = Math.max(0, performance.now() - started);
      observation?.stopped(source, elapsed, timeoutMs === undefined ? undefined : Math.max(0, elapsed - timeoutMs));
    } catch { /* Observation cannot change cancellation or delivery. */ }
  };
  let stop;
  let stopped = false;
  const interrupted = new Promise((_, reject) => {
    stop = (reason, source) => {
      if (stopped) return;
      stopped = true;
      observedStop(source);
      reject(reason);
      controller.abort(reason);
    };
  });
  const cancel = () => stop(owner.reason, "owner");
  owner?.addEventListener("abort", cancel, { once: true });
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
    let reference = "";
    try { if (observation?.requestId) reference = ` Request ID: ${observation.requestId}.`; } catch {}
    stop(new DOMException(`Tempo did not respond before the wait ended.${reference}`, "TimeoutError"), "deadline");
  }, timeoutMs);

  try {
    const operation = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return deliver(controller.signal);
    });
    const result = await Promise.race([operation, interrupted]);
    controller.signal.throwIfAborted();
    finish(undefined, result);
    return result;
  } catch (error) {
    finish(error, undefined, true);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    owner?.removeEventListener("abort", cancel);
  }
}

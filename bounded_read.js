// Local browser budgets cover the reply, including body parsing. Expiry never
// determines whether a server operation was accepted.
export const SMALL_READ_TIMEOUT_MS = 5_000;
export const SHORT_ACK_TIMEOUT_MS = 10_000;

export function boundedRead(owner, read) {
  return waitForDelivery(owner, read, SMALL_READ_TIMEOUT_MS);
}

// Race the whole operation so a transport that ignores abort still settles
// for its caller. Without a deadline, only an explicit owner can stop waiting.
export async function waitForDelivery(owner, deliver, timeoutMs) {
  owner?.throwIfAborted();
  if (!owner && timeoutMs === undefined) return deliver(undefined);

  const controller = new AbortController();
  let stop;
  const interrupted = new Promise((_, reject) => {
    stop = reason => {
      reject(reason);
      controller.abort(reason);
    };
  });
  const cancel = () => stop(owner.reason);
  owner?.addEventListener("abort", cancel, { once: true });
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
    stop(new DOMException("Tempo did not respond before the wait ended.", "TimeoutError"));
  }, timeoutMs);

  try {
    const operation = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return deliver(controller.signal);
    });
    const result = await Promise.race([operation, interrupted]);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    owner?.removeEventListener("abort", cancel);
  }
}

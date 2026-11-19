const readTimeoutMs = 5000;

// Keep one deadline across fetch and body parsing, including transports that ignore abort.
export async function boundedRead(owner, read) {
  owner?.throwIfAborted();
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
  const timer = setTimeout(() => {
    stop(new DOMException("The evidence read timed out.", "TimeoutError"));
  }, readTimeoutMs);

  try {
    const operation = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return read(controller.signal);
    });
    const result = await Promise.race([operation, interrupted]);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
    owner?.removeEventListener("abort", cancel);
  }
}

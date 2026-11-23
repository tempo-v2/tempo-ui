import { createContext, useCallback, useEffect, useState } from "react";
import { SMALL_READ_TIMEOUT_MS } from "./bounded_read.js";
import { requestJson } from "./content_transport.js";
import { object, string } from "./wire_values.js";

export const ApplicationContext = createContext(null);

export async function readApplicationContext(signal) {
  const reply = await requestJson("/api/context", {
    method: "GET",
    cache: "no-store",
    expectedStatus: 200,
    timeoutMs: SMALL_READ_TIMEOUT_MS,
    signal,
  });
  object(reply, ["status", "dataset_id", "schema_version"], "Tempo context");
  if (reply.status !== "ready" || !Number.isSafeInteger(reply.schema_version) || reply.schema_version < 1)
    throw new TypeError("Tempo returned invalid application context.");
  return { datasetId: string(reply.dataset_id, "dataset_id", true) };
}

export function useApplicationContextReader() {
  const [reading, setReading] = useState(0);
  const [context, setContext] = useState({ datasetId: null, issue: null });
  const refresh = useCallback(() => {
    setContext({ datasetId: null, issue: null });
    setReading(value => value + 1);
  }, []);
  useEffect(() => {
    const owner = new AbortController();
    readApplicationContext(owner.signal).then(value => {
      if (!owner.signal.aborted) setContext({ ...value, issue: null });
    }, error => {
      if (!owner.signal.aborted) setContext({
        datasetId: null,
        issue: error.status === 503 ? "Tempo storage is unavailable." : "Could not identify the current Tempo data.",
      });
    });
    return () => owner.abort();
  }, [reading]);
  return { ...context, refresh };
}

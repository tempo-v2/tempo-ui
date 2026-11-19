import { waitForDelivery } from "./bounded_read.js";

const storeName = "commands";

function largeCommand(mode, run) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("tempo-content-recovery", 1);
    open.onupgradeneeded = () => open.result.createObjectStore(storeName);
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error("Tempo recovery storage is busy."));
    open.onsuccess = () => {
      const db = open.result;
      try {
        const transaction = db.transaction(storeName, mode);
        const request = run(transaction.objectStore(storeName));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () => reject(transaction.error);
      } catch (error) {
        reject(error);
      } finally {
        db.close();
      }
    };
  });
}

// Keep the existing per-tab session keys. On quota overflow the session
// holds a reference and IndexedDB holds the immutable command.
export function commandRecovery(storageKey, summarize = () => null) {
  const largeKey = `${storageKey}-external`;
  const external = () => JSON.parse(sessionStorage.getItem(largeKey) || "null");

  const payloadObject = command => command && typeof command === "object" && !Array.isArray(command);
  function entry({ strict = false } = {}) {
    const rawPointer = sessionStorage.getItem(largeKey);
    const stored = JSON.parse(strict ? rawPointer ?? "null" : rawPointer || "null");
    if (strict && rawPointer !== null &&
        (!payloadObject(stored) || typeof stored.id !== "string" || !stored.id ||
          !Object.hasOwn(stored, "identity"))) throw new Error("Invalid saved command reference.");
    if (stored) {
      return {
        command: stored.identity,
        async load() {
          const command = await largeCommand("readonly", store => store.get(stored.id));
          if (!command || (strict && !payloadObject(command))) throw new Error("The saved command is unavailable.");
          return command;
        },
      };
    }
    const rawCommand = sessionStorage.getItem(storageKey);
    const command = JSON.parse(strict ? rawCommand ?? "null" : rawCommand || "null");
    if (strict && rawCommand !== null && !payloadObject(command)) throw new Error("Invalid saved command.");
    return command && { command, load: () => command };
  }

  return {
    entry,
    hasPending() {
      try {
        return !!entry();
      } catch {
        return false;
      }
    },
    async load(options) {
      return (await entry(options)?.load()) ?? null;
    },
    // Detaching the tab's replay record is separate from deleting an
    // unreferenced payload. An explicit dismissal can detach corrupt metadata.
    async clear() {
      const raw = sessionStorage.getItem(largeKey);
      let pointer;
      try { pointer = JSON.parse(raw); } catch {}
      sessionStorage.removeItem(storageKey);
      if (raw === null) return { orphaned: false };
      sessionStorage.removeItem(largeKey);
      if (typeof pointer?.id !== "string" || !pointer.id) return { orphaned: true };
      try {
        await largeCommand("readwrite", store => store.delete(pointer.id));
        return { orphaned: false };
      } catch {
        return { orphaned: true };
      }
    },
    async save(command) {
      const stored = external();
      if (!command) {
        if (stored) {
          sessionStorage.removeItem(largeKey);
          await largeCommand("readwrite", store => store.delete(stored.id));
        } else {
          sessionStorage.removeItem(storageKey);
        }
        return;
      }
      if (stored || JSON.parse(sessionStorage.getItem(storageKey) || "null"))
        throw new Error("A command is still pending.");
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(command));
      } catch (error) {
        if (error.name !== "QuotaExceededError") throw error;
        const id = crypto.randomUUID();
        await largeCommand("readwrite", store => store.add(command, id));
        try {
          sessionStorage.setItem(largeKey, JSON.stringify({ id, identity: summarize(command) }));
        } catch (error) {
          await largeCommand("readwrite", store => store.delete(id));
          throw error;
        }
      }
    },
  };
}

export const studyMoveDetails = { "X-Tempo-Move-Details": "1" };

export class JsonHttpError extends Error {
  constructor(status, details, fallback = `Server returned HTTP ${status}.`) {
    super(details?.message || fallback);
    this.name = "JsonHttpError";
    this.status = status;
    this.code = details?.code;
    this.retryable = details?.retryable;
    this.details = details;
  }
}

function structuredError(value) {
  if (value?.status !== "error" || typeof value.code !== "string" || !value.code.trim() ||
      (Object.hasOwn(value, "message") && typeof value.message !== "string") ||
      (Object.hasOwn(value, "retryable") && typeof value.retryable !== "boolean")) return undefined;
  return value;
}

// Successful JSON is passed unchanged to its endpoint validator, including
// domain errors carried in HTTP 200 responses.
export function requestJson(path, { method, payload, headers, cache, signal, timeoutMs, expectedStatus } = {}) {
  return waitForDelivery(signal, async requestSignal => {
    const response = await fetch(path, {
      ...(method !== undefined && { method }),
      ...(cache !== undefined && { cache }),
      ...(headers !== undefined && { headers }),
      ...(payload !== undefined && {
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(payload),
      }),
      signal: requestSignal,
    });
    // A late response from a noncooperative fetch has no caller.
    requestSignal?.throwIfAborted();
    if (response.ok) {
      if (expectedStatus !== undefined && response.status !== expectedStatus) {
        throw new JsonHttpError(response.status, undefined,
          `Tempo returned HTTP ${response.status} where HTTP ${expectedStatus} was expected.`);
      }
      return response.json();
    }
    let details;
    try {
      details = structuredError(await response.json());
    } catch {
      // HTML, an empty reply and malformed JSON still carry the HTTP status.
    }
    throw new JsonHttpError(response.status, details);
  }, timeoutMs);
}

// PGN uploads and saves keep caller-selected waiting. They have no shared deadline.
export function postCommand(path, command, signal, headers, { timeoutMs } = {}) {
  return requestJson(path, { method: "POST", payload: command, headers, signal, timeoutMs });
}

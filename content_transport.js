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

  function entry() {
    const stored = external();
    if (stored) {
      return {
        command: stored.identity,
        async load() {
          const command = await largeCommand("readonly", store => store.get(stored.id));
          if (!command) throw new Error("The saved command is unavailable.");
          return command;
        },
      };
    }
    const command = JSON.parse(sessionStorage.getItem(storageKey) || "null");
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
    async load() {
      return (await entry()?.load()) ?? null;
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

export async function postCommand(path, command, signal, headers) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(command),
    signal,
  });
  if (!response.ok) throw new Error(`Server returned ${response.status}`);
  return response.json();
}

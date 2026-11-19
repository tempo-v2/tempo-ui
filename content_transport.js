export function commandRecovery(storageKey) {
  return {
    load: () => JSON.parse(sessionStorage.getItem(storageKey) || "null"),
    save(command) {
      if (command) sessionStorage.setItem(storageKey, JSON.stringify(command));
      else sessionStorage.removeItem(storageKey);
    },
  };
}

export async function postCommand(path, command, signal) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
    signal,
  });
  if (!response.ok) throw new Error(`Server returned ${response.status}`);
  return response.json();
}

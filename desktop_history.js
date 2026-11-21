// Track same-document history so a rejected exit can return to the original entry.
const positionKey = "tempoDesktopEntry";
let accepted;
let restoring = false;
const gameListeners = new Set();

function currentEntry() {
  return { url: location.href, state: history.state, position: history.state?.[positionKey] };
}

function replace(entry) {
  history.replaceState({ ...entry.state, [positionKey]: entry.position }, "", entry.url);
  accepted = currentEntry();
}

export function initializeDesktopHistory() {
  const entry = currentEntry();
  replace({ ...entry, position: entry.position ?? 0 });
}

export function replaceDesktopEntry(state, url) {
  replace({ state, url, position: accepted?.position ?? 0 });
}

export function pushDesktopEntry(state, url) {
  history.pushState({ ...state, [positionKey]: (accepted?.position ?? 0) + 1 }, "", url);
  accepted = currentEntry();
}

export function notifyGamesHistory() {
  for (const listener of gameListeners) listener();
}

export function subscribeGamesHistory(listener) {
  gameListeners.add(listener);
  return () => gameListeners.delete(listener);
}

export function subscribeDesktopHistory(accept) {
  function sync() {
    const entry = currentEntry();
    if (entry.position === accepted.position && entry.url === accepted.url) {
      restoring = false;
      return;
    }
    if (restoring) return;
    if (accept()) {
      replace({ ...entry, position: entry.position ?? accepted.position + 1 });
      notifyGamesHistory();
      return;
    }
    const undo = accepted.position - entry.position;
    if (entry.position != null && undo) {
      restoring = true;
      history.go(undo);
    } else {
      // A native fragment or older entry has no Tempo position to traverse back to.
      pushDesktopEntry(accepted.state, accepted.url);
    }
  }
  window.addEventListener("popstate", sync);
  window.addEventListener("hashchange", sync);
  return () => {
    window.removeEventListener("popstate", sync);
    window.removeEventListener("hashchange", sync);
  };
}

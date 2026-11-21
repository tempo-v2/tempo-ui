export const gamesTabs = [
  ["library", "Library"],
  ["import", "Import"],
  ["analysis", "Analysis"],
  ["coverage", "Coverage"],
];

export function gamesTabUrl(tab) {
  return gamesTabs.some(([id]) => id === tab) ? "#games?tab=" + tab : "#games";
}

export function requestedGamesTab() {
  return gamesTabs.find(([id]) => window.location.hash === gamesTabUrl(id))?.[0];
}

const identityFields = ["dataset_id", "source", "game_id", "learner"];

export function reviewAddress() {
  if (!window.location.hash.startsWith("#games?") || requestedGamesTab()) return null;
  const params = new URLSearchParams(window.location.hash.slice(7));
  const address = Object.fromEntries(identityFields.map(key => [key, params.get(key)]));
  return { ...address, repertoire_id: params.get("book") || null,
    start: params.has("start") ? Number(params.get("start")) : null,
    ply: params.has("ply") ? Number(params.get("ply")) : null,
    branch: params.get("branch")?.split(" ").filter(Boolean) ?? [] };
}

export function reviewUrl(address) {
  const params = new URLSearchParams(identityFields.map(key => [key, address[key]]));
  if (address.repertoire_id) params.set("book", address.repertoire_id);
  if (Number.isSafeInteger(address.ply)) params.set("ply", String(address.ply));
  if (Number.isSafeInteger(address.start)) params.set("start", String(address.start));
  if (address.branch?.length) params.set("branch", address.branch.join(" "));
  return "#games?" + params;
}

export function sameGame(a, b) {
  return a.source === b.source && a.game_id === b.game_id && a.learner === b.learner;
}

function visitKey(address) {
  return "tempo.game-visit.v1." + JSON.stringify([address.dataset_id, address.source, address.game_id, address.learner]);
}

export function readVisit(address) {
  try {
    const visit = JSON.parse(localStorage.getItem(visitKey(address)));
    return visit?.address && sameGame(visit.address, address) && visit.address.dataset_id === address.dataset_id ? visit : null;
  } catch { return null; }
}

export function rememberVisit(address, {saved, comparison} = {}) {
  try {
    const previous = readVisit(address);
    localStorage.setItem(visitKey(address), JSON.stringify({
      address,
      saved: saved || previous?.saved || null,
      comparison: comparison || (previous?.comparison?.repertoire_id === address.repertoire_id ? previous.comparison : null),
    }));
  } catch { /* The address in the browser still provides a resumable link. */ }
}

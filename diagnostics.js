// Local, bounded observations of delivery. These records never determine whether
// a command was accepted, and never contain command bodies or server messages.
const capacity = 500;
const events = [];
let discarded = 0;
let sequence = 0;

const routes = new Set([
  "/api/study", "/api/study/presence", "/api/study-progress", "/api/study/relevance", "/api/study/game-context",
  "/api/study/analysis-context", "/api/study/analysis-line", "/api/study/review-mark",
  "/api/study/card-details", "/api/study/saved-reviews", "/api/repertoires", "/api/tactics", "/api/tactic-settings",
  "/api/tactics-collection", "/api/games", "/api/games/library", "/api/games/review",
  "/api/games/job", "/api/games/refresh", "/api/games/import", "/api/games/reprocess",
  "/api/games/choose", "/api/games/backfill", "/api/games/backfill/retry", "/api/games/model",
  "/api/games/gaps", "/api/games/gap-draft", "/api/games/gap-line", "/api/games/gap-line/status", "/api/games/gap-analysis",
  "/api/games/gap-explorer", "/api/games/detectors", "/api/games/detection",
  "/api/games/detection-result", "/api/games/tactics", "/api/games/tactics/command",
  "/api/games/tactics/report", "/api/games/tactics/position", "/api/analysis/evidence", "/api/analysis/result",
]);
const choices = {
  event: new Set(["request_start", "response_headers", "request_end", "late_response", "late_body"]),
  route: new Set([...routes, "other"]),
  method: new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "OTHER"]),
  phase: new Set(["not_started", "fetch", "body"]),
  outcome: new Set(["received", "http_error", "timeout", "cancelled", "invalid_json", "failed"]),
  stop_source: new Set(["deadline", "owner"]),
  error_name: new Set(["TimeoutError", "AbortError", "JsonHttpError", "SyntaxError", "TypeError", "Other"]),
  visibility: new Set(["visible", "hidden", "prerender"]),
};
const numbers = ["at_ms", "elapsed_ms", "fetch_ms", "body_ms", "budget_ms", "deadline_delay_ms", "server_ms", "http_status"];
const booleans = ["server_request_matches", "application_error"];

export function monotonicNow() {
  try { return performance.now(); } catch { return 0; }
}

function wallTime() {
  try { return Date.now(); } catch { return 0; }
}

export function requestId() {
  try { return crypto.randomUUID(); } catch {
    // Correlation only: this is never a command ID or authorization token.
    let entropy = "00000000";
    try { entropy = Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0"); } catch {}
    return `${wallTime().toString(16).padStart(16, "0")}${(++sequence).toString(16).padStart(8, "0")}${entropy}`;
  }
}

export function diagnosticRoute(path) {
  if (typeof path !== "string") return "other";
  const route = path.split(/[?#]/, 1)[0];
  return routes.has(route) ? route : "other";
}

// Copy only bounded scalar fields. Neither arbitrary strings nor nested values
// can enter the export, including through unknown routes or error messages.
export function recordDiagnostic(input) {
  try {
    const record = {};
    for (const [key, allowed] of Object.entries(choices)) {
      if (allowed.has(input[key])) record[key] = input[key];
    }
    if (!record.event) return;
    for (const key of numbers) {
      const value = input[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER)
        record[key] = Math.round(value * 1000) / 1000;
    }
    for (const key of booleans) if (typeof input[key] === "boolean") record[key] = input[key];
    for (const key of ["request_id", "run_id"]) {
      const value = input[key];
      const format = key === "request_id" ? /^[0-9a-fA-F-]{8,64}$/
        : /^[0-9a-f]{1,16}-[0-9]{1,10}-[0-9a-f]{1,16}$/;
      if (typeof value === "string" && format.test(value)) record[key] = value;
    }
    record.at_ms ??= wallTime();
    if (events.length === capacity) { events.shift(); discarded++; }
    events.push(record);
  } catch { discarded++; }
}

export function diagnosticsSnapshot() {
  return {
    schema_version: 1, source: "tempo-ui", capacity, discarded_events: discarded,
    events: events.map(event => ({ ...event })),
  };
}

export function clearDiagnostics() {
  events.length = 0;
  discarded = 0;
}

export function downloadDiagnostics() {
  let url;
  try {
    const blob = new Blob([JSON.stringify(diagnosticsSnapshot(), null, 2)], { type: "application/json" });
    url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "tempo-browser-diagnostics.json";
    link.click();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 1000);
    return true;
  } catch {
    try { if (url) URL.revokeObjectURL(url); } catch {}
    return false;
  }
}

try {
  if (typeof window !== "undefined") window.tempoDiagnostics = Object.freeze({
    snapshot: diagnosticsSnapshot, download: downloadDiagnostics,
  });
} catch { /* Diagnostics must never prevent the application from starting. */ }

export function observeRequest(path, method, budget) {
  const id = requestId();
  const started = monotonicNow();
  const fields = { request_id: id, route: diagnosticRoute(path), method: method ?? "GET", budget_ms: budget };
  let phase = "not_started";
  let headersAt;
  let finished = false;
  function emit(event, extra = {}) {
    recordDiagnostic({ ...fields, event, phase, elapsed_ms: Math.max(0, monotonicNow() - started), ...extra });
  }
  emit("request_start");
  return {
    requestId: id,
    start() { phase = "fetch"; },
    headers(response) {
      try {
        if (finished) { emit("late_response"); return; }
        fields.http_status = response.status;
        const echoed = response.headers?.get("X-Tempo-Request-Id");
        if (echoed) fields.server_request_matches = echoed === id;
        fields.run_id = response.headers?.get("X-Tempo-Run-Id");
        const timing = response.headers?.get("Server-Timing");
        const match = typeof timing === "string" && timing.length <= 256
          && /(?:^|,)\s*tempo;dur=([0-9]+(?:\.[0-9]+)?)(?:\s*,|\s*$)/.exec(timing);
        if (match) fields.server_ms = Number(match[1]);
      } catch { /* Missing or unreadable optional headers do not affect a reply. */ }
      headersAt = monotonicNow();
      fields.fetch_ms = Math.max(0, headersAt - started);
      phase = "body";
      emit("response_headers");
    },
    body() { if (finished) emit("late_body"); },
    stopped(source, elapsed, delay) {
      fields.stop_source = source;
      if (source === "deadline") fields.deadline_delay_ms = delay;
      try { fields.visibility = document.visibilityState; } catch {}
    },
    finish(error, value, failed = false) {
      if (finished) return;
      finished = true;
      try {
        const name = error?.name;
        const outcome = !failed ? "received" : name === "TimeoutError" ? "timeout"
          : fields.stop_source === "owner" ? "cancelled" : name === "JsonHttpError" ? "http_error"
          : name === "SyntaxError" && phase === "body" ? "invalid_json" : "failed";
        emit("request_end", {
          outcome,
          error_name: failed ? choices.error_name.has(name) ? name : "Other" : undefined,
          body_ms: headersAt === undefined ? undefined : Math.max(0, monotonicNow() - headersAt),
          application_error: value?.status === "error",
        });
      } catch { discarded++; }
    },
  };
}

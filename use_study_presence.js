import { useEffect, useRef } from "react";
import { observeRequest } from "./diagnostics.js";

const HEARTBEAT_MS = 10_000;

function reportPresence(report) {
  const path = "/api/study/presence";
  const observation = observeRequest(path, "POST");
  observation.start();
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Tempo-Request-Id": observation.requestId },
    body: JSON.stringify(report),
    keepalive: true,
  }).then(response => {
    observation.headers(response);
    observation.finish();
    return response;
  }, error => {
    // The next heartbeat renews presence after a reconnect.
    observation.finish(error, undefined, true);
  });
}

function presenceIdentity() {
  return { tab: crypto.randomUUID(), sequence: 0 };
}

/** Track one visit to Study. The service owns quiet time and lease expiry. */
export function watchStudyPresence(surface, send = reportPresence, identity = presenceIdentity()) {
  let active = false;
  let hiddenByNavigation = false;
  const publish = state => void send({ tab: identity.tab, sequence: ++identity.sequence, state });
  const release = () => {
    if (!active) return;
    active = false;
    publish("inactive");
  };
  const sync = () => {
    const visible = !hiddenByNavigation && document.visibilityState === "visible";
    const focused = visible && (surface === "phone" || document.hasFocus());
    if (!focused) release();
    else if (!active) {
      active = true;
      publish("active");
    }
  };
  const hidePage = () => {
    hiddenByNavigation = true;
    release();
  };
  const showPage = () => {
    hiddenByNavigation = false;
    sync();
  };
  const blur = () => { if (surface === "desktop") release(); };

  document.addEventListener("visibilitychange", sync);
  window.addEventListener("focus", sync);
  window.addEventListener("blur", blur);
  window.addEventListener("pagehide", hidePage);
  window.addEventListener("pageshow", showPage);
  sync();
  const heartbeat = setInterval(() => {
    const wasActive = active;
    sync();
    if (active && wasActive) publish("active");
  }, HEARTBEAT_MS);

  return () => {
    clearInterval(heartbeat);
    document.removeEventListener("visibilitychange", sync);
    window.removeEventListener("focus", sync);
    window.removeEventListener("blur", blur);
    window.removeEventListener("pagehide", hidePage);
    window.removeEventListener("pageshow", showPage);
    release();
  };
}

export function useStudyPresence(surface) {
  const identity = useRef(null);
  useEffect(() => {
    if (!surface) return;
    identity.current ??= presenceIdentity();
    return watchStudyPresence(surface, reportPresence, identity.current);
  }, [surface]);
}

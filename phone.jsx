import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "@tempo-v2/core-components/styles.css";
import "./style.css";

async function requestStudy(path, options) {
  const unreachable = "Could not reach Tempo. Check Tailscale and make sure your MacBook is awake, then retry.";
  const response = await fetch(path, { ...options, signal: AbortSignal.timeout(15_000) })
    .catch(() => { throw new Error(unreachable); });
  if ([502, 503, 504].includes(response.status)) throw new Error(unreachable);
  return response;
}

createRoot(document.getElementById("root")).render(<App requestStudy={requestStudy} boardContinuation />);

import { useEffect, useState } from "react";
import { postCommand } from "./content_transport.js";

const counts = (row) =>
  row &&
  ["white", "draws", "black"].every(
    (k) => Number.isSafeInteger(row[k]) && row[k] >= 0,
  );
const uci = (value) => typeof value === "string" && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(value);
const move = (row) => row && uci(row.uci);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function checkedData(source, data) {
  let valid = false;
  if (data)
    switch (source) {
      case "masters":
      case "rated":
        valid =
          counts(data) &&
          Array.isArray(data.moves) &&
          data.moves.every((row) => move(row) && counts(row) && ["white", "draws", "black"].every((k) => row[k] <= data[k]));
        break;
      case "stockfish":
        valid =
          typeof data.comparison_complete === "boolean" &&
          Array.isArray(data.candidates) &&
          data.candidates.every(
            (row) =>
              move(row) &&
              ((Number.isSafeInteger(row.centipawns) && row.mate == null) ||
                (Number.isSafeInteger(row.mate) && row.centipawns == null)),
          );
        break;
      case "maia":
        valid =
          data.probabilities &&
          typeof data.probabilities === "object" &&
          !Array.isArray(data.probabilities) &&
          Object.values(data.probabilities).every(
            (p) => Number.isFinite(p) && p >= 0 && p <= 1,
          );
        break;
      case "repertoire":
        valid =
          Array.isArray(data.exact) &&
          data.exact.every((row) => move(row) && typeof row.repertoire_id === "string") &&
          record(data.repertoire_names) &&
          Object.values(data.repertoire_names).every((name) => typeof name === "string") &&
          ["current", "other"].every(
            (group) =>
              Array.isArray(data.nearby?.[group]) &&
              data.nearby[group].every(
                (p) =>
                  typeof p?.fen === "string" &&
                  Array.isArray(p.responses) &&
                  p.responses.every((m) => move(m) && typeof m.san === "string" && typeof m.reusable === "boolean"),
              ) &&
              Array.isArray(data.similar_responses?.[group]) &&
              data.similar_responses[group].every((m) => move(m) && Number.isSafeInteger(m.position_count) && m.position_count > 0),
          );
        break;
    }
  if (!valid)
    throw new Error("Tempo could not read this source’s move evidence.");
  return data;
}

export function usePositionEvidence(fen, source, options, retry) {
  const [reply, setReply] = useState(null);
  const key = JSON.stringify([fen, source, options, retry]);
  useEffect(() => {
    const owner = new AbortController();
    let timer;
    const request_id = crypto.randomUUID();
    async function load() {
      try {
        const signal = AbortSignal.any([
          owner.signal,
          AbortSignal.timeout(45000),
        ]);
        const display = async (result) => {
          if (owner.signal.aborted) return;
          if (result.status === "running") {
            timer = setTimeout(async () => {
              try {
                await display(
                  await postCommand(
                    "/api/analysis/result",
                    { request_id },
                    signal,
                  ),
                );
              } catch (error) {
                if (!owner.signal.aborted)
                  setReply({ key, error: error.message });
              }
            }, 300);
          } else if (
            result.status === "complete" &&
            result.request_id === request_id &&
            result.fen === fen &&
            result.source === source
          ) {
            setReply({ key, data: checkedData(source, result.data) });
          } else
            setReply({
              key,
              error: result.message || "Position evidence unavailable",
            });
        };
        await display(
          await postCommand(
            "/api/analysis/evidence",
            { request_id, fen, source, ...options },
            signal,
          ),
        );
      } catch (error) {
        if (!owner.signal.aborted) setReply({ key, error: error.message });
      }
    }
    timer = setTimeout(load, 180);
    return () => {
      owner.abort();
      clearTimeout(timer);
    };
  }, [key]);
  return reply?.key === key ? reply : {};
}

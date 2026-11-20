import { useEffect, useState } from "react";
import { postCommand } from "./content_transport.js";
import { checkedPositionEvidence } from "./source_evidence.js";

export function usePositionEvidence(fen, source, options, retry, legal) {
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
          if (result?.request_id !== request_id || result.fen !== fen || result.source !== source)
            throw new Error("The result belongs to a different position. Try again.");
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
          } else if (result.status === "complete") {
            setReply({ key, data: checkedPositionEvidence(source, result.data, legal) });
          } else
            setReply({
              key,
              error: result.status === "error" && typeof result.message === "string" && result.message
                ? result.message : "Position evidence unavailable",
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

import { useEffect, useState } from "react";
import { postCommand } from "./content_transport.js";
import { checkedPositionEvidence } from "./source_evidence.js";

export function usePositionEvidence(fen, source, options, retry, legal, enabled = true) {
  const [reply, setReply] = useState(null);
  const key = JSON.stringify([fen, source, options, retry, enabled]);
  useEffect(() => {
    if (!enabled) return;
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
            const data = checkedPositionEvidence(source, result.data, legal);
            if (options.review_version && !matchesReviewEvidence(data, options, legal)) {
              setReply({key, stale:true, error:"The evidence belongs to a different repertoire version. Reload the game comparison."});
            } else setReply({key, data});
          } else
            setReply({
              key,
              stale: ["stale_dataset","stale_repertoire"].includes(result.code),
              code: result.code,
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

export function matchesReviewEvidence(data, options, legal) {
  return data.dataset_id === options.dataset_id && data.repertoire_id === options.repertoire_id &&
    data.document_id === options.review_version.document_id && data.content_revision === options.review_version.revision &&
    Array.isArray(data.prepared_uci) && data.prepared_uci.every(move => legal.has(move)) &&
    new Set(data.prepared_uci).size === data.prepared_uci.length;
}

export function useReviewRepertoireEvidence(fen, review, legal, retry, enabled) {
  const available = !!review.repertoire_id && review.comparison?.source_available && !!review.document_id;
  const reply = usePositionEvidence(fen, "repertoire", {
    dataset_id:review.dataset_id, repertoire_id:review.repertoire_id, learner_color:review.learner_color,
    repertoire_scope:"game",
    review_version:{revision:review.revision, document_id:review.document_id},
  }, retry, legal, !!(available && enabled));
  if (!available && enabled) return {error:"Authored preparation is unavailable for this game comparison."};
  return {...reply, prepared:reply.data?.prepared_uci};
}

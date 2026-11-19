import { useEffect, useState } from "react";
import { postCommand } from "./content_transport.js";
import { safeGameLink } from "./game_commands.js";
import { validateRevealedLine } from "./validate_study_view.js";
import { object, string } from "./wire_values.js";

export function useStudyGameContext(datasetId, attemptId) {
  const [loaded, setLoaded] = useState(null);
  useEffect(() => {
    if (!datasetId || !attemptId) return;
    const request = new AbortController();
    async function read() {
      const reply = await postCommand("/api/study/game-context",
        { dataset_id: datasetId, attempt_id: attemptId }, request.signal);
      object(reply, ["context"], "game context reply");
      if (reply.context === null) return;
      const context = reply.context;
      object(context, ["played_san", "line", "url"], "game context");
      const value = {
        playedSan: string(context.played_san, "played move", true),
        line: validateRevealedLine(context.line),
        url: safeGameLink(context.url),
      };
      if (!request.signal.aborted) setLoaded({ datasetId, attemptId, value });
    }
    // A missing source or interrupted presentation read leaves the lesson usable.
    void read().catch(() => {});
    return () => request.abort();
  }, [datasetId, attemptId]);
  return loaded?.datasetId === datasetId && loaded?.attemptId === attemptId
    ? loaded.value : null;
}

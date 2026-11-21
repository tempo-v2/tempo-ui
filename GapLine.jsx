import React, { useEffect, useState } from "react";
import { Chess } from "chess.js";
import { Button } from "@tempo-v2/core-components";
import { playBoardMove } from "./board_move.js";
import { readGapLine, startGapLine } from "./game_commands.js";

function checkedPreview(reply, request, depth) {
  if (reply.request_id !== request.request_id || reply.content_revision !== request.gap.base_revision ||
      reply.through_move !== depth || !["running", "ready"].includes(reply.status)) {
    throw new Error("The preview belongs to a different gap. Try again.");
  }
  if (reply.status === "running") return reply;
  const board = new Chess();
  if (!Array.isArray(reply.anchor_route) || reply.anchor_route.length > depth * 2) {
    throw new Error("The preview contains an invalid opening route.");
  }
  for (const uci of reply.anchor_route) playBoardMove(board, uci);
  if (board.fen() !== new Chess(reply.anchor_fen).fen()) {
    throw new Error("The preview contains an invalid opening route.");
  }
  const steps = reply.steps;
  if (!Array.isArray(steps) || !steps.length || steps.length > depth * 2 || steps[0].uci !== request.gap.response) {
    throw new Error("The preview contains an invalid line.");
  }
  const positions = steps.map(step => {
    if (typeof step.san !== "string" || !playBoardMove(board, step.uci)) {
      throw new Error("The preview contains an invalid move.");
    }
    return board.fen();
  });
  const save = reply.save_command;
  if (save && (save.command !== "save" || save.dataset_id !== request.gap.dataset_id ||
      save.repertoire_id !== request.gap.repertoire_id || typeof save.pgn !== "string" ||
      typeof save.token !== "string" || !save.token)) {
    throw new Error("The line is missing its save authorization.");
  }
  return { ...reply, positions };
}

export function useGapLine(gap, selected) {
  const [state, setState] = useState(null);
  const [retry, setRetry] = useState(0);
  const forecast = gap.forecast;
  const enabled = !!forecast?.report_id && Number.isInteger(forecast?.through_move);
  useEffect(() => {
    if (!enabled || !selected) return;
    const owner = new AbortController();
    const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(85_000)]);
    const request = {
      request_id: crypto.randomUUID(),
      report_id: forecast.report_id,
      gap: { ...gap.address, response: selected, base_revision: gap.details.content_revision },
    };
    let timer;
    function publish(value) {
      if (!owner.signal.aborted) setState({ gap, selected, retry, value });
    }
    async function observe(start) {
      try {
        const raw = start ? await startGapLine(request, signal)
          : await readGapLine({ request_id: request.request_id }, signal);
        if (owner.signal.aborted) return;
        const value = checkedPreview(raw, request, forecast.through_move);
        publish(value);
        if (value.status === "running") timer = setTimeout(() => void observe(false), 400);
      } catch (error) {
        publish({ status: "error", message: error.message });
      }
    }
    void observe(true);
    return () => {
      owner.abort();
      clearTimeout(timer);
    };
  }, [enabled, forecast, gap, selected, retry]);

  const value = enabled && selected ? (state?.gap === gap && state.selected === selected && state.retry === retry
    ? state.value : { status: "running" }) : null;
  return [value, () => setRetry(attempt => attempt + 1)];
}

const stopping = {
  terminal: "The line ends the game here.",
  opponent_evidence: "Move probabilities ran out. You can save the replies shown.",
  learner_evidence: "Tempo could not suggest another reply. You can save the replies shown.",
  deadline: "The preview reached its time limit. You can save the replies shown.",
};

export function GapLine({ line, depth, viewing, onView, onRetry, locked }) {
  return (
    <section className="gap-line" aria-label="Likely line">
      {line.status === "running" && <p role="status">Building line through your move {depth}
        {line.reached != null && ` · through move ${line.reached} so far`}…</p>}
      {line.status === "error" && <>
        <p role="status">{line.message}</p>
        <Button disabled={locked} onClick={onRetry}>Retry line preview</Button>
      </>}
      {line.status === "ready" && <>
        <p>{line.steps.filter(step => step.new_reply).length} new
          {line.steps.filter(step => step.new_reply).length === 1 ? " reply" : " replies"} in this line</p>
        <ul className="gap-line-moves">
          {line.steps.map((step, index) => (
            <li key={index}>
              <button type="button" disabled={locked} aria-pressed={viewing === index}
                onClick={() => onView(index)}>
                {step.move_number}{(index ? line.positions[index - 1] : line.anchor_fen).split(" ")[1] === "w" ? "." : "…"}{step.san}
                {step.new_reply && " · New reply"}
              </button>
            </li>
          ))}
        </ul>
        {viewing != null && <Button disabled={locked} onClick={() => onView(null)}>Return to first reply</Button>}
        {stopping[line.stop] && <p role="status">{stopping[line.stop]}</p>}
      </>}
    </section>
  );
}

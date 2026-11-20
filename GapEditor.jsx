import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import { TempoBoard as Board } from "./board_preferences.jsx";
import { Button, Dialog, StatusNotice } from "@tempo-v2/core-components";
import { playBoardMove } from "./board_move.js";
import { GapAnalysis, GapExplorer } from "./GapAnalysis.jsx";
import { previewGapResponse, repertoireError, staleGapCodes, writeGapContinuation } from "./gap_save.js";
import { PromotionChooser } from "./PromotionChooser.jsx";
import { LichessControl } from "./LichessControl.jsx";
import { boardWithLeadIn, lineFromBoard } from "./lichess_analysis.js";
import { hasPendingRepertoireCommand, savePendingRepertoireCommand, sendRepertoireCommand } from "./repertoire_commands.js";

const percent = value => value == null ? "Unknown" : `${(value * 100).toFixed(1)}%`;
const shape = (uci, brush) => ({ orig: uci.slice(0, 2), dest: uci.slice(2, 4), brush });

export function GapEditor({ gap, recovery, onClose, onStale, onAdvance, onAnalyze, suspended }) {
  const { draft, learner_color: color, actual_san, response_move_labels: labels } = gap.details;
  const [selected, setSelected] = useState(recovery?.response ?? "");
  const [suggestion, setSuggestion] = useState(null);
  const recommendationSettled = useRef(!!recovery);
  const [hover, setHover] = useState("");
  const [focus, setFocus] = useState("");
  const [promotion, setPromotion] = useState(null);
  const [issue, setIssue] = useState("");
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null);
  const [loadPending, setLoadPending] = useState(() => recovery?.loadPending);
  const [settled, setSettled] = useState(recovery?.accepted ? { status: "repertoires" } : null);
  const saveToken = useRef(recovery?.token);
  const inFlight = useRef(false);
  const board = useRef(null);
  const position = `${gap.address.dataset_id}:${gap.address.repertoire_id}:${draft.fen}`;
  const revision = gap.details.content_revision;
  const moveOptions = useMemo(() => {
    const bySquare = new Map();
    const destinations = new Map();
    for (const move of draft.legal_moves) {
      const from = move.slice(0, 2), to = move.slice(2, 4), id = from + to;
      if (!bySquare.has(id)) {
        bySquare.set(id, []);
        if (!destinations.has(from)) destinations.set(from, []);
        destinations.get(from).push(to);
      }
      bySquare.get(id).push(move);
    }
    return { bySquare, destinations, legal: new Set(draft.legal_moves) };
  }, [draft.legal_moves]);
  const selectedLabel = labels[selected] ?? "response";
  const preview = hover || focus;
  const stagedBoard = useMemo(() => {
    if (!selected || suggestion) return null;
    const current = new Chess(draft.fen);
    playBoardMove(current, selected);
    return current;
  }, [draft.fen, selected, suggestion]);
  const compare = preview && preview !== selected;
  const fen = !compare && stagedBoard ? stagedBoard.fen() : draft.fen;
  const exportLine = useMemo(() => {
    const anchored = boardWithLeadIn(draft.fen, gap.details.anchor_route);
    if (!compare && stagedBoard) playBoardMove(anchored, selected);
    return lineFromBoard(anchored);
  }, [draft.fen, gap.details.anchor_route, selected, stagedBoard, compare]);
  const turn = fen.split(" ")[1] === "w" ? "white" : "black";
  const check = useMemo(() => new Chess(fen).isCheck() ? turn : false, [fen, turn]);
  const shapes = [
    ...(selected ? [shape(selected, "green")] : []),
    ...(compare ? [shape(preview, "blue")] : []),
  ];
  const locked = busy || !!pending || !!loadPending || !!settled || stale;
  const moveNumber = Number(draft.fen.split(" ")[5]) - (color === "white" ? 1 : 0);
  const opponentLabel = `${moveNumber}${color === "white" ? "…" : "."}${actual_san}`;

  const offerRecommendation = useCallback(next => {
    if (recommendationSettled.current || !moveOptions.legal.has(next.uci) ||
        !["similar", "stockfish"].includes(next.basis)) return;
    recommendationSettled.current = true;
    setSuggestion(next);
    setSelected(next.uci);
  }, [moveOptions]);

  const stagedManually = selected && !suggestion;
  const recommendationReason = suggestion?.basis === "similar"
    ? `Used in ${suggestion.position_count} nearby ${suggestion.position_count === 1 ? "position" : "positions"} in ${suggestion.scope === "current" ? "this repertoire" : "other repertoires"} · ${suggestion.loss_centipawns} cp behind Stockfish`
    : suggestion?.basis === "stockfish"
      ? `Best Stockfish move · nearest repertoire response was ${suggestion.nearest_loss_centipawns} cp behind`
      : null;

  function select(move) {
    recommendationSettled.current = true;
    setSuggestion(null);
    setHover("");
    setFocus("");
    setPromotion(null);
    setSelected(move);
    setIssue("");
  }

  function onMove(event) {
    if (locked || stagedManually || promotion || event.positionIdentity !== position || event.positionRevision !== revision) return;
    const base = event.from + event.to;
    const options = moveOptions.bySquare.get(base);
    if (!options?.length) return;
    if (options.length > 1) setPromotion({ moves: options.map(move => move[4]), base });
    else select(options[0]);
  }

  function moveButton(move, description) {
    if (!moveOptions.legal.has(move)) return null;
    return (
      <button className="gap-move" type="button" aria-pressed={selected === move} disabled={locked}
        onPointerEnter={() => setHover(move)} onPointerLeave={() => setHover("")}
        onFocus={() => setFocus(move)} onBlur={() => setFocus("")} onClick={() => select(move)}>
        <strong>{labels[move] ?? "Legal move"}</strong><span>{description}</span>
      </button>
    );
  }

  function remember(token, accepted = false) {
    writeGapContinuation({ token, gap, response: selected, accepted });
  }

  async function finish(reply, clearRecovery) {
    // A terminal reply and storage cleanup are separate from loading the next gap.
    setSettled(reply);
    if (reply.status !== "error" && clearRecovery) remember(saveToken.current, true);
    if (clearRecovery) {
      await savePendingRepertoireCommand(null);
      setPending(null);
      setLoadPending(undefined);
    }
    if (reply.status === "error") {
      writeGapContinuation(null);
      setSettled(null);
      setStale(staleGapCodes.has(reply.code));
      throw repertoireError(reply);
    }
    await onAdvance(selectedLabel);
    writeGapContinuation(null);
  }

  function close() {
    if (!inFlight.current && !pending && !loadPending) {
      if (settled) writeGapContinuation(null);
      onClose(settled?.status === "repertoires" ? selectedLabel : undefined);
    }
  }

  async function save() {
    if (inFlight.current || stale || !selected) return;
    inFlight.current = true;
    setBusy(true);
    setIssue("");
    setHover("");
    setFocus("");
    try {
      if (settled) {
        await finish(settled, !!pending || !!loadPending);
        return;
      }
      let command = pending;
      if (loadPending) {
        command = await loadPending();
        setPending(command);
        setLoadPending(undefined);
      }
      if (!command) {
        if (hasPendingRepertoireCommand()) throw new Error("A repertoire save is still pending. Reload Tempo to recover it.");
        try {
          command = await previewGapResponse(gap, selected, AbortSignal.timeout(10_000));
        } catch (error) {
          setStale(staleGapCodes.has(error.code));
          throw error;
        }
        remember(command.token);
        await savePendingRepertoireCommand(command);
        saveToken.current = command.token;
        setPending(command);
      }
      const reply = await sendRepertoireCommand(command, AbortSignal.timeout(10_000));
      if (reply.status === "error" && reply.retryable) throw repertoireError(reply);
      await finish(reply, true);
    } catch (error) {
      setIssue(error.message || "Tempo could not complete this request.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!recovery) return;
    const timer = setTimeout(() => void save(), 0);
    return () => clearTimeout(timer);
  }, []);


  if (suspended) return null;
  return (
    <Dialog open title={`Respond to ${opponentLabel}`} onClose={close}>
      <div className="gap-editor">
        <p className="gap-repertoire">{gap.details.repertoire_name}</p>
        {settled && settled.status !== "error" && (
          <p role="status">Saved {selectedLabel}.</p>
        )}
        {issue && <StatusNotice kind="error">{issue}</StatusNotice>}
        {stale ? (
          <div className="actions">
            <Button onClick={onStale}>Refresh gaps</Button>
            <Button onClick={close}>Close</Button>
          </div>
        ) : settled ? (
          <div className="actions">
            <Button disabled={busy} onClick={() => void save()}>
              {busy ? "Loading next gap…" : settled.status === "error" ? "Finish recovery" : "Retry loading next gap"}
            </Button>
            <Button disabled={busy || !!pending || !!loadPending} onClick={close}>Close</Button>
          </div>
        ) : (
          <>
            <div className="gap-layout">
              <div className="gap-board" onPointerDownCapture={() => {
                if (!locked) recommendationSettled.current = true;
              }}>
                <Board ref={board} fen={fen} orientation={color} turn={turn} check={check}
                  mode="legal" destinations={moveOptions.destinations}
                  positionIdentity={position} positionRevision={revision}
                  locked={locked || !!stagedManually || !!promotion}
                  lastMove={[gap.address.actual_move.slice(0, 2), gap.address.actual_move.slice(2, 4)]}
                  coordinates="edges" onMove={onMove} shapes={shapes} ariaLabel="Repertoire response board" />
              </div>
              <div className="gap-statistics">
                <h3>Your response</h3>
                <GapAnalysis gap={gap} color={color} moveButton={moveButton}
                  onRecommendation={offerRecommendation} />
                <GapExplorer gap={gap} color={color} moveButton={moveButton} />
                <details>
                  <summary>Before the opponent’s move</summary>
                  <p>{gap.details.profile} · Local coverage {percent(gap.details.local_coverage)}</p>
                  <p>Probability of {actual_san} · {percent(gap.details.actual_probability)}</p>
                  {gap.details.top_replies?.length > 0 && <ul>{gap.details.top_replies.map(([move, probability]) => (
                    <li key={move}>{gap.details.opponent_move_labels[move] ?? "Move unavailable"} · {percent(probability)}</li>
                  ))}</ul>}
                </details>
              </div>
            </div>
            <div className="actions gap-editor-actions">
              <div className="gap-selection" role="status">
                <span>{selected ? `${suggestion ? "Suggested" : "Selected"} ${selectedLabel}` : "Play a move on the board."}</span>
                {recommendationReason && <small>{recommendationReason}</small>}
              </div>
              <Button disabled={locked} onClick={() => onAnalyze({
                datasetId: gap.address.dataset_id, repertoireId: gap.address.repertoire_id,
                fen: draft.fen, color, name: gap.details.repertoire_name, anchorRoute: gap.details.anchor_route,
              })}>Analyze lines</Button>
              <LichessControl fen={fen} line={exportLine} orientation={color} />
              {selected && <Button disabled={locked} onClick={() => select("")}>Clear response</Button>}
              <Button variant="primary" disabled={busy || !selected} onClick={() => void save()}>
                {busy ? "Saving response…" : pending || loadPending ? "Retry save" : "Save response"}
              </Button>
              <Button disabled={busy || !!pending || !!loadPending} onClick={close}>Close</Button>
            </div>
          </>
        )}
      </div>
      <PromotionChooser choice={promotion} onChoose={(choice, role) => select(choice.base + role)} onCancel={() => {
        setPromotion(null);
        board.current?.clearInput();
      }} />
    </Dialog>
  );
}

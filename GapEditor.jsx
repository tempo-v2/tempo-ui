import React, { useEffect, useMemo, useRef, useState } from "react";
import { MainBoard } from "./MainBoard.jsx";
import { Chess } from "chess.js";
import { Button, Dialog, IconButton, StatusNotice } from "@tempo-v2/core-components";
import { CloseIcon } from "./ControlIcons.jsx";
import { closeDialogShortcut } from "./shortcuts.js";
import { playBoardMove } from "./board_move.js";
import { previewGapResponse, repertoireError, staleGapCodes, writeGapContinuation } from "./gap_save.js";
import { PromotionChooser } from "./PromotionChooser.jsx";
import { LichessControl } from "./LichessControl.jsx";
import { boardWithLeadIn, lineFromBoard } from "./lichess_analysis.js";
import { hasPendingRepertoireCommand, savePendingRepertoireCommand, sendRepertoireCommand } from "./repertoire_commands.js";
import { usePageExitGuard } from "./page_exit_guard.js";

// The signed append rewrites the retained catalog. Give acceptance time to
// settle before asking the user to replay the exact pending command.
const gapSaveTimeoutMs = 30_000;
const percent = value => value == null ? "Unknown" : `${(value * 100).toFixed(1)}%`;
const shape = (uci, brush) => ({ orig: uci.slice(0, 2), dest: uci.slice(2, 4), brush });

export function GapEditor({ gap, recovery, onClose, onStale, onAdvance, onAnalyze, suspended, previousSave, phoneBuild }) {
  const { draft, learner_color: color, actual_san, response_move_labels: labels } = gap.details;
  const [selected, setSelected] = useState(recovery?.response ?? "");
  const savedLabel = useRef(recovery?.savedLabel);
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
    return { bySquare, destinations };
  }, [draft.legal_moves]);
  const selectedLabel = labels[selected] ?? "response";
  const stagedBoard = useMemo(() => {
    if (!selected) return null;
    const current = new Chess(draft.fen);
    playBoardMove(current, selected);
    return current;
  }, [draft.fen, selected]);
  const fen = stagedBoard ? stagedBoard.fen() : draft.fen;
  const exportLine = useMemo(() => {
    if (phoneBuild) return null;
    const anchored = boardWithLeadIn(draft.fen, gap.details.anchor_route);
    if (stagedBoard) playBoardMove(anchored, selected);
    return lineFromBoard(anchored);
  }, [draft.fen, gap.details.anchor_route, selected, stagedBoard, phoneBuild]);
  const turn = fen.split(" ")[1] === "w" ? "white" : "black";
  const check = useMemo(() => new Chess(fen).isCheck() ? turn : false, [fen, turn]);
  const shapes = selected ? [shape(selected, "green")] : [];
  const locked = busy || !!pending || !!loadPending || !!settled || stale;
  usePageExitGuard(!!phoneBuild && (busy || !!pending || !!loadPending));
  const moveNumber = Number(draft.fen.split(" ")[5]) - (color === "white" ? 1 : 0);
  const opponentLabel = `${moveNumber}${color === "white" ? "…" : "."}${actual_san}`;

  function select(move) {
    setPromotion(null);
    setSelected(move);
    setIssue("");
  }

  function onMove(event) {
    if (locked || selected || promotion || event.positionIdentity !== position || event.positionRevision !== revision) return;
    const base = event.from + event.to;
    const options = moveOptions.bySquare.get(base);
    if (!options?.length) return;
    if (options.length > 1) setPromotion({ moves: options.map(move => move[4]), base });
    else select(options[0]);
  }

  function remember(token, accepted = false) {
    writeGapContinuation({ token, gap, response: selected, accepted, savedLabel: savedLabel.current });
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
    await onAdvance(savedLabel.current ?? selectedLabel);
    writeGapContinuation(null);
  }

  function close() {
    if (!inFlight.current && !pending && !loadPending) {
      if (settled) writeGapContinuation(null);
      onClose(settled?.status === "repertoires" ? savedLabel.current ?? selectedLabel : undefined);
    }
  }

  async function save() {
    if (inFlight.current || stale || !selected) return;
    inFlight.current = true;
    setBusy(true);
    setIssue("");
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
          savedLabel.current = selectedLabel;
        } catch (error) {
          setStale(staleGapCodes.has(error.code));
          throw error;
        }
        remember(command.token);
        await savePendingRepertoireCommand(command);
        saveToken.current = command.token;
        setPending(command);
      }
      const reply = await sendRepertoireCommand(command, AbortSignal.timeout(gapSaveTimeoutMs));
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
  const closeButton = (
    <IconButton label="Close" shortcut={closeDialogShortcut}
      disabled={busy || !!pending || !!loadPending} onClick={close}><CloseIcon /></IconButton>
  );
  return (
    <Dialog open title={`Respond to ${opponentLabel}`} onClose={close}>
      <div className={phoneBuild ? "gap-editor gap-editor-phone" : "gap-editor"}>
        {previousSave && !settled && <StatusNotice>{previousSave}</StatusNotice>}
        <p className="gap-repertoire">{gap.details.repertoire_name}</p>
        {settled && settled.status !== "error" && (
          <p role="status">Saved {savedLabel.current ?? selectedLabel}.</p>
        )}
        {issue && <StatusNotice kind="error">{issue}</StatusNotice>}
        {stale ? (
          <div className="actions">
            <Button onClick={onStale}>Refresh gaps</Button>
            <IconButton label="Close" shortcut={closeDialogShortcut} onClick={close}><CloseIcon /></IconButton>
          </div>
        ) : settled ? (
          <div className="actions">
            <Button disabled={busy} onClick={() => void save()}>
              {busy ? "Loading next gap…" : settled.status === "error" ? "Finish recovery" : "Retry loading next gap"}
            </Button>
            {closeButton}
          </div>
        ) : (
          <>
            <div className="gap-layout">
              <div className="gap-board desktop-board-frame">
                <MainBoard ref={board} fen={fen} orientation={color} turn={turn} check={check}
                  mode="legal" destinations={moveOptions.destinations}
                  positionIdentity={position} positionRevision={revision}
                  locked={locked || !!selected || !!promotion}
                  lastMove={[gap.address.actual_move.slice(0, 2), gap.address.actual_move.slice(2, 4)]}
                  coordinates="edges" onMove={onMove} shapes={shapes} ariaLabel="Repertoire response board" />
              </div>
              {!phoneBuild && <div className="gap-statistics">
                <h3>Your response</h3>
                <details>
                  <summary>Before the opponent’s move</summary>
                  <p>{gap.details.profile} · Local coverage {percent(gap.details.local_coverage)}</p>
                  <p>Probability of {actual_san} · {percent(gap.details.actual_probability)}</p>
                  {gap.details.top_replies?.length > 0 && <ul>{gap.details.top_replies.map(([move, probability]) => (
                    <li key={move}>{gap.details.opponent_move_labels[move] ?? "Move unavailable"} · {percent(probability)}</li>
                  ))}</ul>}
                </details>
              </div>}
            </div>
            <div className="actions gap-editor-actions">
              <div className="gap-selection" role="status">
                <span>{selected ? `Selected ${selectedLabel}` : "Play a move on the board."}</span>
              </div>
              {onAnalyze && <Button disabled={locked} onClick={() => onAnalyze({
                datasetId: gap.address.dataset_id, repertoireId: gap.address.repertoire_id,
                fen: draft.fen, color, name: gap.details.repertoire_name, anchorRoute: gap.details.anchor_route,
                repertoireScope: "game",
              })}>Analyze lines</Button>}
              {!phoneBuild && <LichessControl fen={fen} line={exportLine} orientation={color} />}
              {selected && <Button disabled={locked} onClick={() => select("")}>Clear response</Button>}
              <Button variant="primary" disabled={busy || !selected} onClick={() => void save()}>
                {busy ? "Saving response…" : pending || loadPending ? "Retry save" : "Save response"}
              </Button>
              {closeButton}
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

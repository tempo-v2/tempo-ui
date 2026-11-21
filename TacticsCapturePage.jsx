import React, { useEffect, useRef, useState } from "react";
import { Board, Button, PageHeader, StatusNotice, Surface } from "@tempo-v2/core-components";
import { MoveTrail } from "./MoveTrail.jsx";
import { turnFromFen } from "./StudyBoard.jsx";
import { sendRepertoireCommand } from "./repertoire_commands.js";
import { sendTacticCommand, tacticRecovery } from "./tactic_commands.js";
import { LichessControl } from "./LichessControl.jsx";
import { TacticBuilder } from "./TacticBuilder.jsx";
import { usePageExitGuard } from "./page_exit_guard.js";

function PreviewBoard({ fen, orientation, record }) {
  const side = turnFromFen(fen);
  return (
    <div className="capture-board">
      <Board fen={fen} orientation={orientation} turn={side} check={false}
        mode="select" readOnly positionIdentity={`preview-${record}-${fen}`} positionRevision={0}
        ariaLabel="Tactic solver preview" />
    </div>
  );
}

function notation({ san, fen_before: fen }) {
  const fields = fen.split(" ");
  return `${fields[5]}${fields[1] === "b" ? "..." : "."} ${san}`;
}

function CaptureRow({ row, selection, checked, onSelect, onDraft, onApply, busy }) {
  const appliedRoute = selection?.route ?? (row.routes.length === 1 ? row.routes[0].route : "");
  const [cursor, setCursor] = useState(0);
  const [route, setRoute] = useState(appliedRoute);
  const [start, setStart] = useState(selection?.start ?? "");
  const [end, setEnd] = useState(selection?.end ?? "");
  const [setup, setSetup] = useState(selection?.setup_plies ?? "");
  const moves = row.routes.find((candidate) => candidate.route === route)?.moves ?? [];
  const shown = moves[start === "" ? 0 : start]?.fen_before;
  const dirty = route !== appliedRoute || start !== (selection?.start ?? "") ||
    end !== (selection?.end ?? "") || setup !== (selection?.setup_plies ?? "");
  useEffect(() => { onDraft(dirty); }, [dirty]);
  const segmentValid = start !== "" && end !== "" && end > start;
  const canApply = (route !== "" || setup !== "") &&
    (start === "" && end === "" || segmentValid);
  const fen = row.status === "valid" && row.solver_fen && !dirty
    ? row.replay?.moves[cursor - 1]?.fen ?? row.replay?.start_fen ?? row.solver_fen : shown;
  const replay = row.status === "valid" && !dirty ? row.replay : null;
  const orientation = fen && turnFromFen(replay?.start_fen ?? fen);
  function selectRoute(event) {
    setRoute(event.target.value === "" ? "" : Number(event.target.value));
    setStart("");
    setEnd("");
  }
  function apply() {
    onApply({
      record: row.record,
      ...(route !== "" && { route }),
      ...(segmentValid && { start, end }),
      ...(!segmentValid && setup !== "" && { setup_plies: setup }),
    });
  }

  return (
    <article className="capture-row" aria-label={`Record ${row.record + 1}`}>
      <h3>{row.label ?? `Record ${row.record + 1}`}</h3>
      {row.message && <StatusNotice kind={row.status === "invalid" ? "error" : undefined}>{row.message}</StatusNotice>}
      {row.status === "valid" && (
        <label className="capture-check">
          <input type="checkbox" checked={checked} disabled={busy || dirty} onChange={onSelect} />
          Select tactic {row.record + 1} for capture
        </label>
      )}
      {fen && <PreviewBoard fen={fen} orientation={orientation} record={row.record} />}
      {replay && <MoveTrail line={replay} index={cursor} onInspect={setCursor} />}
      {fen && <LichessControl fen={fen} line={replay} orientation={orientation} />}
      {row.routes.length > 0 && (
        <details open={row.status === "selection_required" || undefined}>
          <summary>Choose variation, move range, or setup</summary>
          <div className="capture-selection">
            {row.routes.length > 1 && (
              <label>Variation
                <select value={route} disabled={busy} onChange={selectRoute}>
                  <option value="">Choose variation</option>
                  {row.routes.map(({ route: index, moves: list }) => (
                    <option key={index} value={index}>Variation {index + 1} ({list.length} moves)</option>
                  ))}
                </select>
              </label>
            )}
            {moves.length > 0 && (
              <>
                <label>First solution move
                  <select value={start} disabled={busy} onChange={(event) => {
                    setStart(event.target.value === "" ? "" : Number(event.target.value));
                    setEnd("");
                  }}>
                    <option value="">Choose starting move</option>
                    {moves.map((move, index) => <option key={index} value={index}>{notation(move)}</option>)}
                  </select>
                </label>
                <label>Last solution move
                  <select value={end} disabled={busy || start === ""} onChange={(event) => {
                    setEnd(event.target.value === "" ? "" : Number(event.target.value));
                  }}>
                    <option value="">Choose ending move</option>
                    {moves.map((move, index) => index >= start && (
                      <option key={index} value={index + 1}>{notation(move)}</option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <label>Setup before solution
              <select value={setup} disabled={busy || start !== ""} onChange={(event) => {
                setSetup(event.target.value === "" ? "" : Number(event.target.value));
              }}>
                <option value="">Use PGN convention</option>
                <option value={0}>No setup move</option>
                <option value={1}>Play first move as setup</option>
              </select>
            </label>
          </div>
          <Button disabled={busy || !canApply} onClick={apply}>Apply selection</Button>
        </details>
      )}
    </article>
  );
}

export function TacticsCapturePage({ datasetId, onStudy, onTactics }) {
  const [dataset, setDataset] = useState(datasetId);
  const [mode, setMode] = useState("import");
  const [builderKey, setBuilderKey] = useState(0);
  const [pgn, setPgn] = useState("");
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState([]);
  const [dirtyRows, setDirtyRows] = useState([]);
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(true);
  const [issue, setIssue] = useState(null);
  const [notice, setNotice] = useState(null);
  const file = useRef(null);
  const textarea = useRef(null);
  const generation = useRef(0);
  const savedDraft = useRef(null);
  const fileRead = useRef(0);
  const inFlight = useRef(false);
  const locked = busy || recovering || !!pending;
  usePageExitGuard(locked);
  const validRows = preview?.rows.filter(row => row.status === "valid" && !dirtyRows.includes(row.record)) ?? [];

  async function loadDataset() {
    const reply = await sendRepertoireCommand({ command: "list" });
    if (reply.status === "error") throw new Error(reply.message);
    setDataset(reply.dataset_id);
  }

  async function runRequest(task) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setIssue(null);
    try {
      await task();
    } catch (error) {
      setIssue(error.message || "Delivery uncertain.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function showCommandError(reply) {
    setIssue(reply.message);
    if (reply.code === "stale_dataset" && !reply.retryable) await loadDataset();
  }

  async function save(command, { stored = false } = {}) {
    setNotice(null);
    if (!stored) await tacticRecovery.save(command);
    setPending(command);
    const reply = await sendTacticCommand(command);
    const draft = savedDraft.current;
    const currentImport = draft?.mode === "import" && draft.generation === generation.current;
    if (reply.status !== "error" || !reply.retryable) {
      await tacticRecovery.save(null);
      setPending(null);
      savedDraft.current = null;
    }
    if (reply.status === "error") {
      if (!reply.retryable && currentImport) setPreview(null);
      await showCommandError(reply);
      return;
    }
    if (currentImport) {
      changePgn("");
      if (file.current) file.current.value = "";
      textarea.current?.focus();
    }
    if (draft?.mode === "build") setBuilderKey(key => key + 1);
    setNotice({
      message: reply.count === 1 ? "One tactic saved." : `${reply.count} tactics saved.`,
      alternateSolutions: reply.alternate_solutions,
      readyForReview: reply.ready_for_review,
    });
  }

  function requestPreview(command) {
    return runRequest(async () => {
      const requestedGeneration = generation.current;
      const reply = await sendTacticCommand(command);
      if (reply.status === "error") return showCommandError(reply);
      if (requestedGeneration !== generation.current) return;
      setPreview({ input: command, ...reply });
      setSelected(previous => previous.filter(record => {
        if (preview?.input.pgn !== command.pgn) return false;
        const before = preview.rows.find(row => row.record === record);
        const after = reply.rows.find(row => row.record === record);
        return before?.capture_identity && before.capture_identity === after?.capture_identity &&
          after.status === "valid";
      }));
    });
  }

  function saveBuiltTactic(pgn) {
    return runRequest(async () => {
      setNotice(null);
      const input = { command: "preview", dataset_id: dataset, pgn };
      const reply = await sendTacticCommand(input);
      if (reply.status === "error") return showCommandError(reply);
      const [row] = reply.rows;
      if (reply.rows.length !== 1 || row.record !== 0 || row.status !== "valid") {
        setIssue(row?.message || "The starting position and solution did not produce a valid tactic.");
        return;
      }
      savedDraft.current = { mode: "build" };
      await save({ ...input, command: "save", token: reply.token, selected: [row.record] });
    });
  }

  async function resumeRecovery() {
    setRecovering(true);
    setIssue(null);
    try {
      const recovered = await tacticRecovery.load();
      if (!recovered && !datasetId) await loadDataset();
      setRecovering(false);
      if (recovered) {
        setDataset(recovered.dataset_id);
        await runRequest(() => save(recovered, { stored: true }));
      }
    } catch (error) {
      setIssue(error.message);
    }
  }

  useEffect(() => { void resumeRecovery(); }, []);

  function changePgn(value) {
    ++generation.current;
    setDirtyRows([]);
    setPreview(null);
    setSelected([]);
    setPgn(value);
  }

  async function chooseFile(upload) {
    const reading = ++fileRead.current;
    changePgn("");
    if (!upload) return;
    try {
      const text = await upload.text();
      if (reading === fileRead.current) {
        changePgn(text);
        setIssue(null);
      }
    } catch (error) {
      if (reading === fileRead.current) setIssue(error.message);
    }
  }

  function startPreview(event) {
    event.preventDefault();
    requestPreview({ command: "preview", dataset_id: dataset, pgn });
  }

  function updateSelection(selection) {
    const selections = (preview.input.selections ?? []).filter(({ record }) => record !== selection.record);
    requestPreview({ ...preview.input, selections: [...selections, selection] });
  }

  function toggleRecord(record) {
    setSelected((previous) => previous.includes(record)
      ? previous.filter((selectedRecord) => selectedRecord !== record)
      : [...previous, record]);
  }

  function chooseMode(next) {
    setMode(next);
    setIssue(null);
  }

  return (
    <main className={`tempo-core repertoire-page tactic-capture${mode === "build" ? " capture-building" : ""}`}>
      <PageHeader title="Capture tactics" actions={<div className="actions tactic-page-actions">
        <Button disabled={locked} onClick={onStudy}>Study</Button>
        {onTactics && <Button disabled={locked} onClick={onTactics}>Tactics</Button>}
      </div>} />
      {issue && <StatusNotice kind="error">{issue}</StatusNotice>}
      {notice && (
        <StatusNotice>
          {notice.message}
          {notice.readyForReview > 0 && <p>{notice.readyForReview === 1
            ? "One tactic is ready for review in Study."
            : `${notice.readyForReview} tactics are ready for review in Study.`}</p>}
          {notice.alternateSolutions > 0 && <p>{notice.alternateSolutions} saved tactics have another solution at the same position.</p>}
        </StatusNotice>
      )}
      {recovering && issue && <Button onClick={resumeRecovery}>Retry recovery</Button>}
      {pending && <Button pending={busy} onClick={() => runRequest(() => save(pending, { stored: true }))}>Retry capture</Button>}
      <div className="actions capture-modes" role="group" aria-label="Capture method">
        <Button disabled={locked} aria-pressed={mode === "import"} onClick={() => chooseMode("import")}>Import PGN</Button>
        <Button disabled={locked} aria-pressed={mode === "build"} onClick={() => chooseMode("build")}>Build a tactic</Button>
      </div>
      <div hidden={mode !== "build"}>
        <TacticBuilder key={builderKey} locked={locked || mode !== "build"} canSave={!!dataset}
          saving={busy && mode === "build"} onSave={saveBuiltTactic} />
      </div>
      <div hidden={mode !== "import"} className="capture-import">
        <Surface>
          <h2>Import PGN</h2>
          <form className="repertoire-form" onSubmit={startPreview}>
            <label>PGN file
              <input ref={file} type="file" accept=".pgn,text/plain" disabled={locked}
                onChange={(event) => chooseFile(event.target.files[0])} />
            </label>
            <label>Or paste PGN
              <textarea ref={textarea} rows={7} value={pgn} onChange={(event) => {
                ++fileRead.current;
                changePgn(event.target.value);
              }} />
            </label>
            <Button type="submit" disabled={locked || !dataset || !pgn.trim()}>Preview tactics</Button>
          </form>
        </Surface>
        {preview && (
          <Surface>
            <h2>Preview tactics</h2>
            <div className="actions">
              <Button disabled={locked || !validRows.length}
                onClick={() => setSelected(validRows.map(row => row.record))}>Select all valid</Button>
              <Button disabled={locked || !selected.length} onClick={() => setSelected([])}>Clear selection</Button>
            </div>
            {preview.rows.map((row) => {
              const selection = preview.input.selections?.find(({ record }) => record === row.record);
              return <CaptureRow key={`${row.record}/${JSON.stringify(selection ?? null)}`} row={row} busy={locked}
                selection={selection}
                checked={selected.includes(row.record)} onSelect={() => toggleRecord(row.record)}
                onDraft={dirty => {
                  setDirtyRows(previous => dirty
                    ? (previous.includes(row.record) ? previous : [...previous, row.record])
                    : previous.filter(record => record !== row.record));
                  if (dirty) setSelected(previous => previous.filter(record => record !== row.record));
                }}
                onApply={updateSelection} />;
            })}
            <Button variant="primary" disabled={locked || !selected.length} onClick={() => runRequest(() => {
              savedDraft.current = { mode: "import", generation: generation.current };
              return save({ ...preview.input, command: "save", token: preview.token, selected });
            })}>Save selected tactics</Button>
          </Surface>
        )}
      </div>
    </main>
  );
}

import React, { useEffect, useRef, useState } from "react";
import { Board, Button, PageHeader, StatusNotice, Surface } from "@tempo-v2/core-components";
import { turnFromFen } from "./StudyBoard.jsx";
import { sendRepertoireCommand } from "./repertoire_commands.js";
import { sendTacticCommand, tacticRecovery } from "./tactic_commands.js";

const MAX_PGN_BYTES = 256 * 1024;

function PreviewBoard({ fen, record }) {
  const side = turnFromFen(fen);
  return (
    <div className="capture-board">
      <Board fen={fen} orientation={side} turn={side} check={false}
        mode="select" readOnly positionIdentity={`preview-${record}-${fen}`} positionRevision={0}
        ariaLabel="Tactic solver preview" />
    </div>
  );
}

function CaptureRow({ row, selection, checked, onSelect, onDraft, onApply, busy }) {
  const appliedRoute = selection?.route ?? (row.routes.length === 1 ? row.routes[0].route : "");
  const [route, setRoute] = useState(appliedRoute);
  const [start, setStart] = useState(selection?.start ?? "");
  const [end, setEnd] = useState(selection?.end ?? "");
  const [setup, setSetup] = useState(selection?.setup_plies ?? "");
  const moves = row.routes.find((candidate) => candidate.route === route)?.moves ?? [];
  const shown = moves[start === "" ? 0 : start]?.fen_before;
  const dirty = route !== appliedRoute || start !== (selection?.start ?? "") ||
    end !== (selection?.end ?? "") || setup !== (selection?.setup_plies ?? "");
  const segmentValid = start !== "" && end !== "" && end > start;
  const canApply = (route !== "" || setup !== "") &&
    (start === "" && end === "" || segmentValid);
  const fen = row.status === "valid" && row.solver_fen && !dirty
    ? row.solver_fen : shown;
  function selectRoute(event) {
    onDraft();
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
      {fen && <PreviewBoard fen={fen} record={row.record} />}
      {row.status === "valid" && !dirty && (
        <p>Solution ({row.solution.length} {row.solution.length === 1 ? "move" : "moves"}) {row.solution.join(" ")}</p>
      )}
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
                    onDraft();
                    setStart(event.target.value === "" ? "" : Number(event.target.value));
                    setEnd("");
                  }}>
                    <option value="">Choose starting move</option>
                    {moves.map(({ san }, index) => <option key={index} value={index}>{index + 1}. {san}</option>)}
                  </select>
                </label>
                <label>Last solution move
                  <select value={end} disabled={busy || start === ""} onChange={(event) => {
                    onDraft();
                    setEnd(event.target.value === "" ? "" : Number(event.target.value));
                  }}>
                    <option value="">Choose ending move</option>
                    {moves.map(({ san }, index) => index >= start && (
                      <option key={index} value={index + 1}>{index + 1}. {san}</option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <label>Setup before solution
              <select value={setup} disabled={busy || start !== ""} onChange={(event) => {
                onDraft();
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

export function TacticsCapturePage({ datasetId, onStudy }) {
  const [dataset, setDataset] = useState(datasetId);
  const [pgn, setPgn] = useState("");
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState([]);
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState(null);
  const [notice, setNotice] = useState(null);
  const file = useRef(null);
  const fileRead = useRef(0);
  const inFlight = useRef(false);
  const locked = busy || !!pending;

  async function loadDataset() {
    const reply = await sendRepertoireCommand({ command: "list" });
    if (reply.status === "error") throw new Error(reply.message);
    setDataset(reply.dataset_id);
  }

  async function request(command, durable = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setIssue(null);
    setNotice(null);
    try {
      if (durable) {
        tacticRecovery.save(command);
        setPending(command);
      }
      const reply = await sendTacticCommand(command);
      if (durable && (reply.status !== "error" || !reply.retryable)) {
        tacticRecovery.save(null);
        setPending(null);
      }
      if (reply.status === "error") {
        setIssue(reply.message);
        if (!reply.retryable && command.command === "save") setPreview(null);
        if (reply.code === "stale_dataset" && !reply.retryable) await loadDataset();
      } else if (reply.status === "tactics_preview") {
        setPreview({ input: command, ...reply });
        setSelected([]);
      } else {
        setPreview(null);
        setSelected([]);
        setPgn("");
        if (file.current) file.current.value = "";
        setNotice({
          message: reply.count === 1 ? "One tactic saved." : `${reply.count} tactics saved.`,
          alternateSolutions: reply.alternate_solutions,
          readyForReview: reply.ready_for_review,
        });
      }
    } catch (error) {
      setIssue(error.message || "Delivery uncertain.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    try {
      const recovered = tacticRecovery.load();
      if (recovered) {
        setDataset(recovered.dataset_id);
        request(recovered, true);
      } else if (!datasetId) {
        loadDataset().catch((error) => setIssue(error.message));
      }
    } catch (error) {
      setIssue(error.message);
    }
  }, []);

  function changePgn(value) {
    setPreview(null);
    setSelected([]);
    setPgn(value);
  }

  async function chooseFile(upload) {
    const reading = ++fileRead.current;
    changePgn("");
    if (!upload) return;
    if (upload.size > MAX_PGN_BYTES) {
      setIssue("PGN files must be 256 KiB or smaller.");
      return;
    }
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
    if (new TextEncoder().encode(pgn).length > MAX_PGN_BYTES) {
      setIssue("PGN text must be 256 KiB or smaller.");
      return;
    }
    request({ command: "preview", dataset_id: dataset, pgn });
  }

  function updateSelection(selection) {
    const selections = (preview.input.selections ?? []).filter(({ record }) => record !== selection.record);
    request({ ...preview.input, selections: [...selections, selection] });
  }

  function toggleRecord(record) {
    setSelected((previous) => previous.includes(record)
      ? previous.filter((selectedRecord) => selectedRecord !== record)
      : [...previous, record]);
  }

  return (
    <main className="tempo-core repertoire-page tactic-capture">
      <PageHeader title="Capture tactics" actions={<Button disabled={locked} onClick={onStudy}>Study</Button>} />
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
      {pending && <Button pending={busy} onClick={() => request(pending, true)}>Retry capture</Button>}
      <Surface>
        <h2>Import PGN</h2>
        <form className="repertoire-form" onSubmit={startPreview}>
          <label>PGN file
            <input ref={file} type="file" accept=".pgn,text/plain" disabled={locked}
              onChange={(event) => chooseFile(event.target.files[0])} />
          </label>
          <label>Or paste PGN
            <textarea disabled={locked} rows={7} value={pgn} onChange={(event) => {
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
          {preview.rows.map((row) => (
            <CaptureRow key={`${preview.token}/${row.record}`} row={row} busy={locked}
              selection={preview.input.selections?.find(({ record }) => record === row.record)}
              checked={selected.includes(row.record)} onSelect={() => toggleRecord(row.record)}
              onDraft={() => setSelected((previous) => previous.filter((record) => record !== row.record))}
              onApply={updateSelection} />
          ))}
          <Button variant="primary" disabled={locked || !selected.length} onClick={() => request({
            ...preview.input,
            command: "save",
            token: preview.token,
            selected,
          }, true)}>Save selected tactics</Button>
        </Surface>
      )}
    </main>
  );
}

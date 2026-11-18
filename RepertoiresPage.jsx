import React, { useEffect, useRef, useState } from "react";
import { Button, PageHeader, StatusNotice, Surface } from "@tempo-v2/core-components";
import {
  readPendingRepertoireCommand,
  savePendingRepertoireCommand,
  sendRepertoireCommand,
} from "./repertoire_commands.js";

// Also checked by the server. Check the size before loading a large local file.
const MAX_PGN_BYTES = 256 * 1024;

function PreviewSummary({ preview }) {
  return (
    <dl className="content-preview">
      <dt>Routes</dt><dd>{preview.routes}</dd>
      <dt>Distinct study positions</dt><dd>{preview.positions}</dd>
      <dt>New positions</dt><dd>{preview.added}</dd>
      <dt>Retired positions</dt><dd>{preview.removed}</dd>
      <dt>Changed answers</dt><dd>{preview.changed}</dd>
      <dt>Learned positions affected</dt><dd>{preview.affected_learning}</dd>
    </dl>
  );
}

export function RepertoiresPage({ onStudy }) {
  const [catalog, setCatalog] = useState(null);
  const [destination, setDestination] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState("");
  const [pgn, setPgn] = useState("");
  const [files, setFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState("");
  const [rename, setRename] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(true);
  const [pending, setPending] = useState(null);
  const [issue, setIssue] = useState(null);
  const [notice, setNotice] = useState(null);
  const inFlight = useRef(false);
  const fileRead = useRef(0);
  const repertoire = catalog?.repertoires.find((item) => item.id === destination);
  const locked = busy || !!pending;

  async function request(command, durable = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setIssue(null);
    setNotice(null);
    try {
      if (durable) {
        savePendingRepertoireCommand(command);
        setPending(command);
      }
      const reply = await sendRepertoireCommand(command);
      if (durable && (reply.status !== "error" || !reply.retryable)) {
        savePendingRepertoireCommand(null);
        setPending(null);
      }
      if (reply.status === "error") {
        if (command.command === "save" && !reply.retryable) setPreview(null);
        setIssue(reply.message);
        // A stale dataset can't take another write. Refresh the available destinations.
        if (reply.code === "stale_dataset" && !reply.retryable) {
          setDestination("");
          const current = await sendRepertoireCommand({ command: "list" });
          if (current.status !== "error") setCatalog(current);
        }
        return;
      }
      if (reply.status === "preview") {
        setPreview({ reply, input: command });
      } else {
        setCatalog(reply);
        if (command.command === "save") {
          setNotice("Repertoire saved.");
          setPreview(null);
          setSelectedFile("");
          setPgn("");
          setName("");
        } else if (command.command === "rename") {
          setNotice("Repertoire renamed.");
          setRename(null);
          setPreview(null);
        }
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
      const recover = readPendingRepertoireCommand();
      request(recover || { command: "list" }, !!recover);
    } catch (error) {
      setIssue(error.message);
      setBusy(false);
    }
  }, []);

  async function readFile(file, selection) {
    const intent = ++fileRead.current;
    setPreview(null);
    setSelectedFile(selection);
    setPgn("");
    if (!file) return;
    if (file.size > MAX_PGN_BYTES) {
      setIssue("Each PGN file must be 256 KiB or smaller.");
      return;
    }
    try {
      const text = await file.text();
      if (fileRead.current !== intent) return;
      setPgn(text);
      setIssue(null);
      setName(file.name.replace(/\.pgn$/i, ""));
    } catch (error) {
      if (fileRead.current === intent) setIssue(error.message);
    }
  }

  function previewImport(event) {
    event.preventDefault();
    setPreview(null);
    if (!pgn.trim()) {
      setIssue("Choose a PGN file or paste PGN text.");
      return;
    }
    if (new TextEncoder().encode(pgn).length > MAX_PGN_BYTES) {
      setIssue("Each PGN must be 256 KiB or smaller.");
      return;
    }
    request({
      command: "preview",
      dataset_id: catalog.dataset_id,
      name: repertoire?.name ?? name.trim(),
      learner_color: repertoire?.learner_color ?? color,
      pgn,
      ...(repertoire && { repertoire_id: repertoire.id }),
    });
  }

  return (
    <main className="tempo-core repertoire-page">
      <PageHeader title="Repertoires" actions={
        <Button disabled={locked} onClick={onStudy}>Study</Button>
      } />
      {(issue || notice) && (
        <StatusNotice kind={issue ? "error" : undefined}>{issue ?? notice}</StatusNotice>
      )}
      {pending && <Button pending={busy} onClick={() => request(pending, true)}>Retry save</Button>}
      {!catalog && !locked && (
        <Button onClick={() => request({ command: "list" })}>Reload repertoires</Button>
      )}

      {catalog && (
        <>
          {catalog.repertoires.length > 0 && (
            <Surface>
              <h2>Saved repertoires</h2>
              <ul className="repertoire-list">
                {catalog.repertoires.map((item) => (
                  <li key={item.id}>
                    <div><strong>{item.name}</strong> <span className="repertoire-details">· {item.learner_color} · {item.positions} positions</span></div>
                    {rename?.id === item.id ? (
                      <form className="actions" onSubmit={(event) => {
                        event.preventDefault();
                        request({
                          command: "rename",
                          dataset_id: catalog.dataset_id,
                          repertoire_id: item.id,
                          name: rename.name.trim(),
                        }, true);
                      }}>
                        <label>New name <input required disabled={locked} value={rename.name}
                          onChange={(event) => setRename({ id: item.id, name: event.target.value })} /></label>
                        <Button type="submit" disabled={locked || !rename.name.trim()}>Save name</Button>
                        <Button disabled={locked} onClick={() => setRename(null)}>Cancel</Button>
                      </form>
                    ) : (
                      <Button disabled={locked} onClick={() => setRename({ id: item.id, name: item.name })}>
                        Rename<span className="visually-hidden"> {item.name}</span>
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </Surface>
          )}

          <Surface>
            <h2>Import PGN</h2>
            <form className="repertoire-form" onSubmit={previewImport}>
              {catalog.repertoires.length > 0 && (
                <label>Destination
                  <select disabled={locked} value={destination} onChange={(event) => {
                    setDestination(event.target.value);
                    setPreview(null);
                  }}>
                    <option value="">Create repertoire</option>
                    {catalog.repertoires.map((item) => (
                      <option key={item.id} value={item.id}>Replace {item.name}</option>
                    ))}
                  </select>
                </label>
              )}
              {repertoire ? (
                <p>Upload the complete intended repertoire for {repertoire.name}. Lines omitted from this PGN will retire.</p>
              ) : (
                <div className="repertoire-fields">
                  <label>Repertoire name
                    <input disabled={locked} required value={name} onChange={(event) => {
                      setName(event.target.value);
                      setPreview(null);
                    }} />
                  </label>
                  <label>Learner color
                    <select disabled={locked} required value={color} onChange={(event) => {
                      setColor(event.target.value);
                      setPreview(null);
                    }}>
                      <option value="">Choose color</option>
                      <option value="white">White</option>
                      <option value="black">Black</option>
                    </select>
                  </label>
                </div>
              )}
              <label>PGN files
                <input type="file" accept=".pgn,text/plain" multiple disabled={locked} onChange={(event) => {
                  const chosen = Array.from(event.target.files);
                  setFiles(chosen);
                  readFile(chosen[0], chosen.length ? "0" : "");
                }} />
              </label>
              {files.length > 1 && (
                <label>File to preview
                  <select disabled={locked} value={selectedFile} onChange={(event) => {
                    const selection = event.target.value;
                    readFile(selection === "" ? undefined : files[Number(selection)], selection);
                  }}>
                    <option value="">Choose file</option>
                    {files.map((file, index) => <option key={index} value={String(index)}>{file.name}</option>)}
                  </select>
                </label>
              )}
              <label>{selectedFile === "" ? "Or paste PGN" : "PGN text"}
                <textarea disabled={locked} rows={7} value={pgn} onChange={(event) => {
                  ++fileRead.current;
                  setPgn(event.target.value);
                  setPreview(null);
                }} />
              </label>
              <div className="actions">
                <Button type="submit" disabled={locked || !pgn.trim()}>
                  Preview PGN
                </Button>
              </div>
            </form>
          </Surface>
          {preview && (
            <Surface>
              <h2>{preview.input.repertoire_id ? "Replace" : "Create"} {preview.input.name}</h2>
              <p>Learner color: {preview.input.learner_color}</p>
              <PreviewSummary preview={preview.reply} />
              <Button variant="primary" disabled={locked} onClick={() => request({
                ...preview.input,
                command: "save",
                token: preview.reply.token,
              }, true)}>
                {preview.input.repertoire_id ? "Replace repertoire" : "Create repertoire"}
              </Button>
            </Surface>
          )}
        </>
      )}
    </main>
  );
}

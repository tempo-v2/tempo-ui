import React, { useEffect, useRef, useState } from "react";
import { Button, Dialog, PageHeader, StatusNotice, Surface } from "@tempo-v2/core-components";
import {
  readPendingRepertoireCommand,
  savePendingRepertoireCommand,
  sendRepertoireCommand,
} from "./repertoire_commands.js";


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

function documentAddress(dataset_id, repertoire_id) {
  return { dataset_id, repertoire_id };
}

async function currentDocument(address) {
  const reply = await sendRepertoireCommand({ command: "read_document", ...address });
  if (reply.status === "error") throw new Error(reply.message);
  if (reply.dataset_id !== address.dataset_id || reply.repertoire_id !== address.repertoire_id)
    throw new Error("The reply belongs to a different repertoire.");
  return reply;
}

function downloadDocument(reply) {
  const file = new Blob([reply.document.pgn], { type: "application/x-chess-pgn" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  const name = reply.name.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  link.href = url;
  link.download = `${name || "repertoire"}.pgn`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  const [reset, setReset] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(true);
  const [pending, setPending] = useState(null);
  const [issue, setIssue] = useState(null);
  const [notice, setNotice] = useState(null);
  const [editor, setEditor] = useState(null);
  const [documentBusy, setDocumentBusy] = useState(false);
  const [refresh, setRefresh] = useState(null);
  const [cleanupNeeded, setCleanupNeeded] = useState(false);
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const inFlight = useRef(false);
  const fileRead = useRef(0);
  const documentRead = useRef(0);
  const repertoire = catalog?.repertoires.find((item) => item.id === destination);
  const locked = busy || !!pending || cleanupNeeded || recoveryBlocked || !!refresh;
  const dirty = !refresh && editor?.current?.document.status === "available"
    && editor.text !== editor.current.document.pgn;

  useEffect(() => {
    if (!dirty) return;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function discardDraft() {
    return !dirty || window.confirm("Discard your unsaved repertoire edits?");
  }

  function closeEditor() {
    ++documentRead.current;
    setDocumentBusy(false);
    setEditor(null);
    setPreview(null);
    setIssue(null);
  }

  async function readDocument(address, download = false) {
    const read = ++documentRead.current;
    setDocumentBusy(true);
    setIssue(null);
    try {
      const reply = await currentDocument(address);
      if (documentRead.current !== read) return;
      if (download) {
        if (reply.document.status === "unavailable")
          throw new Error("There is no verified current PGN. Upload a complete replacement to establish it.");
        downloadDocument(reply);
      } else {
        setEditor({ address, current: reply, text: reply.document.pgn ?? "", stale: false });
      }
    } catch (error) {
      if (documentRead.current === read) setIssue(error.message);
    } finally {
      if (documentRead.current === read) setDocumentBusy(false);
    }
  }

  function openEditor(item) {
    if (!discardDraft()) return;
    ++fileRead.current;
    setPreview(null);
    const address = documentAddress(catalog.dataset_id, item.id);
    setEditor({ address, current: null, text: "", stale: false });
    readDocument(address);
  }

  function reloadEditor() {
    if (!discardDraft()) return;
    setPreview(null);
    readDocument(editor.address);
  }

  function clearRecovery() {
    try {
      savePendingRepertoireCommand(null);
      setCleanupNeeded(false);
    } catch {
      setCleanupNeeded(true);
    }
  }

  async function refreshCurrent(next) {
    try {
      if (next.list) {
        const reply = await sendRepertoireCommand({ command: "list" });
        if (reply.status === "error") throw new Error(reply.message);
        setCatalog(reply);
        if (next.reset) {
          const item = reply.dataset_id === next.reset.dataset_id &&
            reply.repertoires.find(({ id }) => id === next.reset.repertoire_id);
          if (item) setNotice(`Progress reset for ${item.name}.`);
        }
        next = { ...next, list: false };
        setRefresh(next);
      }
      if (next.address) {
        const current = await currentDocument(next.address);
        setEditor({ address: next.address, current, text: current.document.pgn ?? "", stale: false });
      }
      setRefresh(null);
    } catch (error) {
      setIssue(error.message || "The current repertoire could not be loaded.");
    }
  }

  async function retryRefresh() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setIssue(null);
    try {
      await refreshCurrent(refresh);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function request(command, { durable = false, stored = false } = {}) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setIssue(null);
    setNotice(null);
    try {
      if (durable && !stored) {
        try {
          savePendingRepertoireCommand(command);
        } catch {
          setIssue("Tempo could not store this command for recovery. It was not sent.");
          return;
        }
        setPending(command);
      }
      const reply = await sendRepertoireCommand(command);
      if (durable && (reply.status !== "error" || !reply.retryable)) {
        setPending(null);
        clearRecovery();
      }
      if (reply.status === "error") {
        if (command.command === "save" && !reply.retryable) setPreview(null);
        if (editor && ["stale_draft", "stale_preview", "stale_dataset"].includes(reply.code))
          setEditor({ ...editor, stale: true });
        setIssue(reply.message);
        if (reply.code === "stale_dataset" && !reply.retryable && !editor) {
          setDestination("");
          const current = await sendRepertoireCommand({ command: "list" });
          if (current.status !== "error") setCatalog(current);
        }
        return;
      }
      if (reply.status === "preview") {
        const { base_revision, ...input } = command;
        setPreview({ reply, input, editing: command.command === "edit_preview" });
      } else if (reply.status === "progress_reset") {
        const item = catalog?.repertoires.find(({ id }) => id === reply.repertoire_id);
        setNotice(item ? `Progress reset for ${item.name}.` : "Repertoire progress reset.");
        const next = { list: true, reset: reply };
        setRefresh(next);
        await refreshCurrent(next);
      } else if (durable) {
        setNotice(command.command === "save" ? "Repertoire saved." : "Repertoire renamed.");
        setPreview(null);
        setRename(null);
        if (command.command === "save" && !editor) {
          setSelectedFile("");
          setPgn("");
          setName("");
        }
        const openDocument = command.command === "save" && editor
          && command.dataset_id === editor.address.dataset_id
          && command.repertoire_id === editor.address.repertoire_id;
        const next = { list: true, address: openDocument ? editor.address : null };
        setRefresh(next);
        await refreshCurrent(next);
      } else {
        setCatalog(reply);
      }
    } catch (error) {
      setIssue(error.message || "Delivery uncertain.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function resumeRecovery() {
    try {
      const recover = readPendingRepertoireCommand();
      setRecoveryBlocked(false);
      if (recover) {
        setPending(recover);
        request(recover, { durable: true, stored: true });
      } else {
        request({ command: "list" });
      }
    } catch {
      setRecoveryBlocked(true);
      setIssue("Tempo could not read its saved repertoire command. Retry before making changes.");
      setBusy(false);
    }
  }

  useEffect(() => {
    resumeRecovery();
    return () => {
      ++documentRead.current;
      ++fileRead.current;
    };
  }, []);

  async function readFile(file, selection) {
    const intent = ++fileRead.current;
    setPreview(null);
    setSelectedFile(selection);
    setPgn("");
    if (!file) return;
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
    request({
      command: "preview",
      dataset_id: catalog.dataset_id,
      name: repertoire?.name ?? name.trim(),
      learner_color: repertoire?.learner_color ?? color,
      pgn,
      ...(repertoire && { repertoire_id: repertoire.id }),
    });
  }

  function previewEdit(event) {
    event.preventDefault();
    if (!editor.current || editor.stale || !editor.text.trim()) return;
    setPreview(null);
    request({
      command: "edit_preview",
      ...editor.address,
      name: editor.current.name,
      learner_color: editor.current.learner_color,
      pgn: editor.text,
      base_revision: editor.current.revision,
    });
  }

  return (
    <main className="tempo-core repertoire-page">
      <PageHeader title="Repertoires" actions={
        <Button disabled={locked} onClick={() => {
          if (discardDraft()) onStudy();
        }}>Study</Button>
      } />
      {notice && <StatusNotice>{notice}</StatusNotice>}
      {issue && <StatusNotice kind="error">{issue}</StatusNotice>}
      {cleanupNeeded && <>
        <StatusNotice kind="error">Tempo could not clear its saved recovery command.</StatusNotice>
        <Button disabled={busy} onClick={clearRecovery}>Retry clearing recovery</Button>
      </>}
      {refresh && <Button pending={busy} onClick={retryRefresh}>Retry reload</Button>}
      {recoveryBlocked && <Button onClick={resumeRecovery}>Retry reading recovery</Button>}
      {pending && <Button pending={busy}
        onClick={() => request(pending, { durable: true, stored: true })}>
        {pending.command === "reset_progress" ? "Retry reset" : "Retry save"}
      </Button>}
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
                    <div className="actions">
                      <Button disabled={locked} onClick={() => openEditor(item)}>
                        Edit<span className="visually-hidden"> {item.name}</span>
                      </Button>
                      <Button disabled={locked || documentBusy} onClick={() =>
                        readDocument(documentAddress(catalog.dataset_id, item.id), true)}>
                        Download PGN<span className="visually-hidden"> for {item.name}</span>
                      </Button>
                      <Button disabled={locked || !!editor} onClick={() => setReset(item)}>
                        Reset progress<span className="visually-hidden"> for {item.name}</span>
                      </Button>
                    </div>
                    {!editor && (rename?.id === item.id ? (
                      <form className="actions" onSubmit={(event) => {
                        event.preventDefault();
                        request({
                          command: "rename",
                          dataset_id: catalog.dataset_id,
                          repertoire_id: item.id,
                          name: rename.name.trim(),
                        }, { durable: true });
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
                    ))}
                  </li>
                ))}
              </ul>
            </Surface>
          )}

          {editor ? (
            <Surface>
              <h2>Edit repertoire{editor.current ? `: ${editor.current.name}` : ""}</h2>
              {documentBusy && <p role="status">Loading current PGN…</p>}
              {!documentBusy && editor.current?.document.status === "unavailable" && (
                <>
                  <p>There is no verified current PGN for this repertoire. Upload a complete replacement to establish it.</p>
                  <Button disabled={locked} onClick={() => {
                    setDestination(editor.address.repertoire_id);
                    closeEditor();
                  }}>Upload replacement</Button>
                </>
              )}
              {editor.current?.document.status === "available" && (
                <form className="repertoire-form" onSubmit={previewEdit}>
                  <p>This document replaces the entire repertoire. Omitted lines will retire.</p>
                  <label>Repertoire PGN
                    <textarea rows={14} value={editor.text} disabled={locked || documentBusy}
                      onChange={(event) => {
                        setEditor({ ...editor, text: event.target.value });
                        setPreview(null);
                      }} />
                  </label>
                  <Button type="submit" disabled={locked || documentBusy || editor.stale || !dirty || !editor.text.trim()}>
                    Preview changes
                  </Button>
                </form>
              )}
              <div className="actions">
                <Button disabled={locked || documentBusy} onClick={reloadEditor}>Reload current PGN</Button>
                <Button disabled={locked} onClick={() => {
                  if (discardDraft()) closeEditor();
                }}>Cancel edit</Button>
              </div>
            </Surface>
          ) : <Surface>
            <h2>Import PGN</h2>
            <form className="repertoire-form" onSubmit={previewImport}>
              {catalog.repertoires.length > 0 && (
                <label>Destination
                  <select disabled={locked} value={destination} onChange={(event) => {
                    ++fileRead.current;
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
                      ++fileRead.current;
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
          </Surface>}
          {preview && (
            <Surface>
              <h2>{preview.input.repertoire_id ? "Replace" : "Create"} {preview.input.name}</h2>
              <p>Learner color: {preview.input.learner_color}</p>
              <PreviewSummary preview={preview.reply} />
              <Button variant="primary" disabled={locked} onClick={() => request({
                ...preview.input,
                command: "save",
                token: preview.reply.token,
              }, { durable: true })}>
                {preview.editing ? "Save repertoire" : preview.input.repertoire_id ? "Replace repertoire" : "Create repertoire"}
              </Button>
            </Surface>
          )}
        </>
      )}
      <Dialog open={!!reset} title={`Reset progress for ${reset?.name ?? "this repertoire"}?`}
        onClose={() => setReset(null)}>
        <p>This erases the repertoire’s Study history and review schedule.
          Its positions become new again. The PGN and imported games are kept.</p>
        <div className="actions">
          <Button onClick={() => setReset(null)}>Cancel</Button>
          <Button variant="danger" disabled={locked} onClick={() => {
            const address = documentAddress(catalog.dataset_id, reset.id);
            setReset(null);
            request({
              command: "reset_progress",
              ...address,
              command_id: crypto.randomUUID(),
            }, { durable: true });
          }}>Reset progress</Button>
        </div>
      </Dialog>
    </main>
  );
}

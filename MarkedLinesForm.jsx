import React, { useEffect, useRef, useState } from "react";
import { Button } from "@tempo-v2/core-components";
import {
  readPendingRepertoireCommand,
  savePendingRepertoireCommand,
  sendRepertoireCommand,
} from "./repertoire_commands.js";

// Own the editable document, marked paths and signed Save recovery independently of board navigation.
export function useMarkedLines(
  {
    datasetId,
    repertoireId,
    name: initialName,
    color: initialColor,
    anchorRoute,
  },
  root,
) {
  const [marked, setMarked] = useState([]);
  const [preview, setPreview] = useState(null);
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const flight = useRef(false);
  const savedAny = useRef(false);
  const [issue, setIssue] = useState("");
  const [notice, setNotice] = useState("");
  const [doc, setDoc] = useState(null);
  const [destination, setDestination] = useState(repertoireId || null);
  const [name, setName] = useState(initialName || "");
  const [color, setColor] = useState(initialColor || "white");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!destination) return;
    const ac = new AbortController();
    setDoc(null);
    sendRepertoireCommand(
      {
        command: "read_document",
        dataset_id: datasetId,
        repertoire_id: destination,
      },
      ac.signal,
    )
      .then((r) => {
        if (ac.signal.aborted) return;
        if (r.status !== "document") throw new Error(r.message);
        setDoc(r);
        setName(r.name);
        setColor(r.learner_color);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setIssue(e.message);
      });
    return () => ac.abort();
  }, [destination, datasetId, refresh]);
  useEffect(() => {
    if (!marked.length || pending) return;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [marked, pending]);
  const locked = busy || !!pending;
  function mark(path) {
    const key = path.join(" ");
    const next = marked.some((p) => p.join(" ") === key)
      ? marked.filter((p) => p.join(" ") !== key)
      : [...marked, path];
    setMarked(next);
    setPreview(null);
    setNotice("");
  }
  async function request(save) {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setIssue("");
    try {
      if (!save) {
        const r = await sendRepertoireCommand(
          {
            command: "marked_preview",
            dataset_id: datasetId,
            repertoire_id: destination,
            name: name.trim(),
            learner_color: color,
            base_revision: doc?.revision ?? null,
            anchor_fen: root,
            ...(anchorRoute && { anchor_route: anchorRoute }),
            lines: marked,
          },
          AbortSignal.timeout(20000),
        );
        if (r.status !== "preview" || !r.save_command?.token)
          throw new Error(r.message || "Preview unavailable");
        setPreview(r);
      } else {
        const cmd = pending || preview.save_command;
        if (!pending && readPendingRepertoireCommand())
          throw new Error("Reload to recover the pending repertoire save.");
        savePendingRepertoireCommand(cmd);
        setPending(cmd);
        const r = await sendRepertoireCommand(cmd, AbortSignal.timeout(20000));
        if (r.status === "error" && r.retryable) throw new Error(r.message);
        savePendingRepertoireCommand(null);
        setPending(null);
        setPreview(null);
        if (r.status === "error") throw new Error(r.message);
        savedAny.current = true;
        setDestination(preview.repertoire_id || destination);
        setMarked([]);
        setNotice("Repertoire saved.");
        setRefresh((n) => n + 1);
      }
    } catch (e) {
      setIssue(e.message);
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }
  return {
    destination,
    name,
    color,
    revision: doc?.revision,
    documentStatus: doc?.document.status,
    marked,
    locked,
    busy,
    pending,
    preview,
    issue,
    notice,
    saved: savedAny.current,
    rename(value) {
      setName(value);
      setPreview(null);
    },
    chooseColor(value) {
      setColor(value);
      setPreview(null);
    },
    mark,
    previewChanges: () => request(false),
    save: () => request(true),
    refreshDocument() {
      setPreview(null);
      setIssue("");
      setRefresh((n) => n + 1);
    },
  };
}

export function MarkedLinesForm({ draft, path, lineLabel }) {
  const {
    destination,
    name,
    color,
    marked,
    locked,
    busy,
    pending,
    preview,
    issue,
    notice,
    documentStatus,
  } = draft;
  const key = path.join(" ");
  return (
    <>
      <section>
        <h2>{destination ? name || "Repertoire" : "New repertoire"}</h2>
        {documentStatus === "unavailable" && (
          <p role="status">
            Upload a verified repertoire PGN before saving marked lines.
          </p>
        )}
        {!destination && (
          <>
            <label>
              Name{" "}
              <input
                value={name}
                disabled={locked}
                onChange={(e) => {
                  draft.rename(e.target.value);
                }}
              />
            </label>{" "}
            <label>
              Side{" "}
              <select
                value={color}
                disabled={locked}
                onChange={(e) => {
                  draft.chooseColor(e.target.value);
                }}
              >
                <option>white</option>
                <option>black</option>
              </select>
            </label>
          </>
        )}
        <div className="actions">
          <Button
            disabled={locked || !path.length}
            onClick={() => draft.mark(path)}
          >
            {marked.some((p) => p.join(" ") === key)
              ? "Unmark line"
              : "Mark line"}
          </Button>
          <Button
            disabled={
              locked ||
              !marked.length ||
              !name.trim() ||
              (!!destination && documentStatus !== "available")
            }
            onClick={draft.previewChanges}
          >
            Preview changes
          </Button>
        </div>
        {marked.length > 0 && (
          <ul>
            {marked.map((p) => (
              <li key={p.join(" ")}>{lineLabel(p)}</li>
            ))}
          </ul>
        )}
        {preview && (
          <section>
            <h3>Changes to {name}</h3>
            <p>
              {preview.added} new positions · {preview.changed} changed answers
              · {preview.removed} retired · {preview.affected_learning} learned
              positions affected
            </p>
            {(preview.replacements || []).map((r, i) => (
              <p key={i}>
                {r.route} · {r.old_move} → {r.new_move}
              </p>
            ))}
            {(preview.retired_routes || []).map((r, i) => (
              <p key={i}>Retire {r}</p>
            ))}
            <Button disabled={busy} onClick={draft.save}>
              {pending ? "Retry save" : "Save repertoire"}
            </Button>
          </section>
        )}
      </section>
      {issue && (
        <p role="alert">
          {issue}{" "}
          {destination && !locked && (
            <button onClick={draft.refreshDocument}>Refresh document</button>
          )}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </>
  );
}

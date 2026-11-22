import React, { useEffect, useState } from "react";
import { Button, StatusNotice } from "@tempo-v2/core-components";
import { coverageStartingLine } from "./game_commands.js";

export function openingNotation(san) {
  return san.length ? san.map((move, index) => index % 2 === 0
    ? `${index / 2 + 1}.${move}` : move).join(" ") : "Initial position";
}

export function CoverageStartingLine({ dataset, repertoire, setting, disabled, onSaved, onScanDepth, alwaysOpen = false }) {
  const [editing, setEditing] = useState(alwaysOpen);
  const [candidate, setCandidate] = useState(null);
  const [result, setResult] = useState(null);
  const [issue, setIssue] = useState("");
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const revision = setting?.revision;
  const addressed = result?.candidate === candidate && result?.revision === revision ? result.reply : null;

  useEffect(() => {
    if (!editing && !setting?.moves.length) return;
    const owner = new AbortController();
    const address = { dataset_id: dataset, repertoire_id: repertoire };
    coverageStartingLine({ ...address, candidate }, owner.signal).then(reply => {
      if (!owner.signal.aborted) setResult({ candidate, revision, reply });
    }, error => {
      if (!owner.signal.aborted) setIssue(error.message);
    });
    return () => owner.abort();
  }, [dataset, repertoire, editing, candidate, revision, reload]);

  function choose(moves) {
    setIssue("");
    setCandidate(moves);
  }

  async function save() {
    if (!addressed || !candidate || saving) return;
    setSaving(true);
    setIssue("");
    try {
      const reply = await coverageStartingLine({
        dataset_id: dataset, repertoire_id: repertoire, candidate,
        save_at_revision: addressed.saved.revision,
      });
      setResult({ candidate: null, revision: reply.saved.revision, reply });
      setCandidate(null);
      setEditing(alwaysOpen);
      onSaved(reply.saved);
    } catch (error) {
      setIssue(error.message);
    } finally {
      setSaving(false);
    }
  }

  const moves = candidate ?? addressed?.saved.moves ?? setting?.moves ?? [];
  const line = addressed?.line;
  const invalid = addressed && moves.length > 0 && !line;
  useEffect(() => {
    const minimum = setting?.moves.length ? addressed?.minimum_move : 1;
    onScanDepth?.({ revision, minimum, blocked: editing || !minimum || minimum > 20 });
  }, [addressed, revision, setting, editing, onScanDepth]);
  const label = line ? openingNotation(line.san) : moves.length ? moves.join(" ") : "Initial position";
  return <div className="repertoire-starting-line">
    <p><strong>{candidate ? "Selected position" : "Start coverage after"}</strong> · {label}</p>
    {invalid && <StatusNotice kind="error">This starting line is missing from the repertoire. Choose a new line before scanning.</StatusNotice>}
    {issue && <StatusNotice kind="error">{issue}</StatusNotice>}
    {!editing && <Button type="button" disabled={disabled} onClick={() => setEditing(true)}>Edit starting line</Button>}
    {editing && <>
      {!addressed && !issue && <p role="status">Loading saved moves…</p>}
      <div className="actions">
        <Button type="button" disabled={saving || !moves.length} onClick={() => choose([])}>Initial position</Button>
        <Button type="button" disabled={saving || !line || !moves.length} onClick={() => choose(moves.slice(0, -1))}>One move back</Button>
        {line && Object.entries(line.choices).map(([uci, san]) =>
          <Button type="button" key={uci} disabled={saving || moves.length >= 39} onClick={() => choose([...moves, uci])}>{san}</Button>)}
      </div>
      <div className="actions">
        <Button type="button" onClick={save} disabled={saving || !addressed || !candidate ||
          (moves.length > 0 && (!addressed.minimum_move || addressed.minimum_move > 20))}>Use this position</Button>
        {issue && <Button type="button" onClick={() => { setIssue(""); setReload(value => value + 1); }}>Reload choices</Button>}
        {!alwaysOpen && <Button type="button" disabled={saving} onClick={() => { choose(null); setEditing(false); }}>Close</Button>}
      </div>
    </>}
  </div>;
}

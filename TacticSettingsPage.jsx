import React, { useEffect, useRef, useState } from "react";
import { Button, PageHeader, StatusNotice, Surface } from "@tempo-v2/core-components";
import { SMALL_READ_TIMEOUT_MS } from "./bounded_read.js";
import { postCommand } from "./content_transport.js";

export function TacticSettingsPage({ onStudy }) {
  const [loaded, setLoaded] = useState(null);
  const [limit, setLimit] = useState("");
  const [selection, setSelection] = useState({ mode: "any" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const requestInFlight = useRef(false);

  async function request(command) {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const timeoutMs = command.command === "get" ? SMALL_READ_TIMEOUT_MS : undefined;
      const reply = await postCommand("/api/tactic-settings", command, undefined, undefined, { timeoutMs });
      if (reply.status === "error") {
        setError(reply);
        return;
      }
      if (reply.status !== "tactic_settings" || reply.schema_version !== 1) throw new Error("Unexpected settings reply.");
      setLoaded(reply);
      setLimit(String(reply.new_tactics_per_day));
      setSelection(reply.selection);
      if (command.command === "save") setNotice("Tactics settings saved.");
    } catch (failure) {
      setError({ message: failure.message, code: failure.code });
    } finally {
      requestInFlight.current = false;
      setBusy(false);
    }
  }

  const load = () => request({ command: "get" });
  useEffect(() => { void load(); }, []);

  const selected = selection.theme_ids ?? [];
  const validLimit = /^\d+$/.test(limit) && Number.isSafeInteger(Number(limit));
  const canSave = validLimit && (selection.mode === "any" || selected.length > 0);
  const groups = new Map();
  for (const theme of loaded?.themes ?? []) {
    if (!groups.has(theme.group)) groups.set(theme.group, []);
    groups.get(theme.group).push(theme);
  }

  function save(event) {
    event.preventDefault();
    if (busy || !canSave) return;
    void request({
      command: "save",
      dataset_id: loaded.dataset_id,
      expected_revision: loaded.revision,
      new_tactics_per_day: Number(limit),
      selection,
    });
  }

  return (
    <main className="tempo-core repertoire-page">
      <PageHeader title="Tactics settings" actions={<Button disabled={busy} onClick={onStudy}>Study</Button>} />
      {error && <StatusNotice kind="error">{error.message}</StatusNotice>}
      {notice && <StatusNotice>{notice}</StatusNotice>}
      {error && (!loaded || ["settings_conflict", "stale_dataset"].includes(error.code)) &&
        <Button disabled={busy} onClick={load}>Reload settings</Button>}
      {!loaded && busy && <p role="status">Loading settings…</p>}
      {loaded && <Surface>
        <form className="repertoire-form" onSubmit={save}>
          <label>New tactics per day
            <input type="number" min="0" step="1" required value={limit} disabled={busy}
              onChange={(event) => { setNotice(null); setLimit(event.target.value); }} />
          </label>
          <fieldset disabled={busy} className="tactic-theme-picker">
            <legend>New tactic types</legend>
            <label><input type="radio" name="tactic-filter" checked={selection.mode === "any"}
              onChange={() => { setNotice(null); setSelection({ mode: "any" }); }} />
              Any tactic, including personal captures</label>
            <label><input type="radio" name="tactic-filter" checked={selection.mode === "selected"}
              onChange={() => { setNotice(null); setSelection(loaded.starter); }} />
              Selected themes</label>
            {selection.mode === "selected" && <>
              <p>Tempo rotates through your themes and starts with easy packs.</p>
              <div className="study-navigation">
                <Button type="button" onClick={() => { setNotice(null); setSelection(loaded.starter); }}>Use starter themes</Button>
                <Button type="button" onClick={() => {
                  setNotice(null);
                  setSelection({ mode: "selected", theme_ids: [] });
                }}>Clear selection</Button>
              </div>
              {[...groups].map(([group, themes]) => (
                <fieldset key={group} className="tactic-theme-group">
                  <legend>{group}</legend>
                  {themes.map(({ id, name }) => (
                    <label key={id}><input type="checkbox" checked={selected.includes(id)}
                      onChange={(event) => {
                        setNotice(null);
                        setSelection({ mode: "selected", theme_ids: event.target.checked
                          ? [...selected, id] : selected.filter((theme) => theme !== id) });
                      }} />
                      {name}</label>
                  ))}
                </fieldset>
              ))}
              {!selected.length && <p>Choose at least one theme.</p>}
            </>}
          </fieldset>
          <Button type="submit" variant="primary" pending={busy} disabled={busy || !canSave}>Save settings</Button>
        </form>
      </Surface>}
    </main>
  );
}

import React, { useEffect, useRef, useState } from "react";
import { Button, PageHeader, StatusNotice, Surface } from "@tempo-v2/core-components";
import { boardThemes, pieceSets, useBoardPreferences } from "./board_preferences.jsx";
import { SHORT_ACK_TIMEOUT_MS, SMALL_READ_TIMEOUT_MS } from "./bounded_read.js";
import { postCommand } from "./content_transport.js";

const fields = ["openings", "tactics", "more", "selection"];

function draftFrom(saved) {
  return {
    openings: String(saved.introductions.repertoire),
    tactics: String(saved.introductions.tactics),
    more: String(saved.more_tactics),
    selection: saved.selection,
  };
}

function sameValue(left, right) {
  if (left === right) return true;
  if (left?.mode !== right?.mode || !left?.mode) return false;
  return (left.theme_ids ?? []).slice().sort().join(",") === (right.theme_ids ?? []).slice().sort().join(",");
}

async function requestSettings(command, signal) {
  const timeoutMs = command.command === "get" ? SMALL_READ_TIMEOUT_MS : SHORT_ACK_TIMEOUT_MS;
  const reply = await postCommand("/api/settings/study", command, signal, undefined, { timeoutMs });
  if (reply?.status === "error")
    throw Object.assign(new Error(reply.message), { rejected: true, code: reply.code });
  if (reply?.status !== "study_settings" || reply.schema_version !== 1 ||
      typeof reply.dataset_id !== "string" || typeof reply.revision !== "string" ||
      typeof reply.study_timezone !== "string" || !Array.isArray(reply.themes) ||
      !Number.isInteger(reply.introductions?.repertoire) || !Number.isInteger(reply.introductions?.tactics) ||
      !Number.isInteger(reply.more_tactics) ||
      !(reply.selection === null || ["any", "selected"].includes(reply.selection?.mode))) {
    throw new Error("Tempo returned an unexpected Settings reply.");
  }
  return reply;
}

function BoardSettings() {
  const { prefs, persisted, update } = useBoardPreferences();
  return (
    <Surface>
      <section className="settings-group" aria-labelledby="board-settings">
        <h2 id="board-settings">Board &amp; sound</h2>
        <p>These preferences apply to this browser.</p>
        <div className="board-preferences">
          <label>Board theme
            <select value={prefs.theme} onChange={event => update({ theme: event.target.value })}>
              {Object.entries(boardThemes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>Pieces
            <select value={prefs.pieceSet} onChange={event => update({ pieceSet: event.target.value })}>
              {Object.entries(pieceSets).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>Volume
            <input type="range" min="0" max="1" step="0.01" value={prefs.volume}
              onChange={event => update({ volume: event.target.valueAsNumber })} />
          </label>
          <label className="sound-toggle">
            <input type="checkbox" checked={prefs.soundEnabled}
              onChange={event => update({ soundEnabled: event.target.checked })} /> Board sounds
          </label>
        </div>
        {!persisted && <StatusNotice kind="error">The browser could only apply your changes in this tab.</StatusNotice>}
      </section>
    </Surface>
  );
}

function TacticThemes({ saved, selection, update }) {
  const selected = selection?.theme_ids ?? [];
  const groups = new Map();
  for (const theme of saved.themes) {
    if (!groups.has(theme.group)) groups.set(theme.group, []);
    groups.get(theme.group).push(theme);
  }
  return (
    <fieldset className="tactic-theme-picker">
      <legend>New tactic types</legend>
      <label><input type="radio" name="tactic-filter" checked={selection === null}
        onChange={() => update(null)} /> Automatic</label>
      <p>Use starter themes when available.</p>
      <label><input type="radio" name="tactic-filter" checked={selection?.mode === "any"}
        onChange={() => update({ mode: "any" })} /> Any tactic, including personal captures</label>
      <label><input type="radio" name="tactic-filter" checked={selection?.mode === "selected"}
        onChange={() => update(saved.starter)} /> Selected themes</label>
      {selection?.mode === "selected" && <>
        <div className="study-navigation">
          <Button type="button" onClick={() => update(saved.starter)}>Use starter themes</Button>
          <Button type="button" onClick={() => update({ mode: "selected", theme_ids: [] })}>Clear selection</Button>
        </div>
        {[...groups].map(([group, themes]) => (
          <fieldset key={group} className="tactic-theme-group">
            <legend>{group}</legend>
            {themes.map(({ id, name }) => (
              <label key={id}><input type="checkbox" checked={selected.includes(id)}
                onChange={event => update({ mode: "selected", theme_ids: event.target.checked
                  ? [...selected, id] : selected.filter(theme => theme !== id) })} />
                {name}</label>
            ))}
          </fieldset>
        ))}
        {!selected.length && <p>Choose at least one theme.</p>}
      </>}
    </fieldset>
  );
}

function Limit({ label, value, update }) {
  return <label>{label}
    <input type="number" min="0" max={Number.MAX_SAFE_INTEGER} step="1" required value={value}
      onChange={event => update(event.target.value)} />
  </label>;
}

export function SettingsPage({ shared, initialSection, onBack }) {
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const [reloadRequired, setReloadRequired] = useState(false);
  const [uncertain, setUncertain] = useState(null);
  const activeRequest = useRef(null);
  const tacticHeading = useRef(null);
  const pageHeading = useRef(null);
  const loaded = !!saved;

  function run(task) {
    if (activeRequest.current) return;
    const owner = new AbortController();
    activeRequest.current = owner;
    setBusy(true);
    setError(null);
    setNotice(null);
    void (async () => {
      try {
        await task(owner.signal);
      } catch (failure) {
        if (!owner.signal.aborted) setError(failure.message);
      } finally {
        if (activeRequest.current === owner) {
          activeRequest.current = null;
          setBusy(false);
        }
      }
    })();
  }

  function applySaved(reply, keepDraft) {
    const next = draftFrom(reply);
    if (keepDraft && saved?.dataset_id === reply.dataset_id) {
      const previous = draftFrom(saved);
      for (const field of fields) {
        if (!sameValue(draft[field], previous[field])) next[field] = draft[field];
      }
    }
    setSaved(reply);
    setDraft(next);
    setReloadRequired(false);
    setUncertain(null);
  }

  async function checkSave(command, signal) {
    const reply = await requestSettings({ command: "get" }, signal);
    const accepted = reply.dataset_id === command.dataset_id &&
      reply.introductions.repertoire === command.introductions.repertoire &&
      reply.introductions.tactics === command.introductions.tactics &&
      reply.more_tactics === command.more_tactics && sameValue(reply.selection, command.selection);
    applySaved(reply, !accepted);
    if (accepted) setNotice("Study settings saved.");
    else if (reply.dataset_id === command.dataset_id)
      setError("The save could not be confirmed. Review your edits before saving again.");
    else setError("The Study dataset changed. Settings now show the current dataset.");
  }

  function load() {
    run(async signal => {
      if (uncertain) await checkSave(uncertain, signal);
      else applySaved(await requestSettings({ command: "get" }, signal), true);
    });
  }

  useEffect(() => {
    if (shared) load();
    return () => {
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, [shared]);

  useEffect(() => {
    pageHeading.current?.focus();
  }, []);

  useEffect(() => {
    if (initialSection === "tactics" && loaded) tacticHeading.current?.focus();
  }, [initialSection, loaded]);

  function update(field, value) {
    setNotice(null);
    setDraft(current => ({ ...current, [field]: value }));
  }

  const editable = loaded && !busy && !uncertain;
  const baseline = loaded ? draftFrom(saved) : null;
  const validLimit = value => /^\d+$/.test(value) && Number.isSafeInteger(Number(value));
  const canSave = editable && !reloadRequired && fields.some(field => !sameValue(draft[field], baseline[field])) &&
    [draft.openings, draft.tactics, draft.more].every(validLimit) &&
    (draft.selection?.mode !== "selected" || draft.selection.theme_ids.length > 0);

  function save(event) {
    event.preventDefault();
    if (!canSave) return;
    const command = {
      command: "save",
      dataset_id: saved.dataset_id,
      expected_revision: saved.revision,
      introductions: { repertoire: Number(draft.openings), tactics: Number(draft.tactics) },
      more_tactics: Number(draft.more),
      selection: draft.selection,
    };
    run(async signal => {
      try {
        applySaved(await requestSettings(command, signal), false);
        setNotice("Study settings saved.");
      } catch (failure) {
        if (signal.aborted) return;
        if (failure.rejected) {
          setReloadRequired(["settings_conflict", "stale_dataset"].includes(failure.code));
          throw failure;
        }
        setUncertain(command);
        await checkSave(command, signal);
      }
    });
  }

  return (
    <main className="tempo-core repertoire-page settings-page">
      <div ref={pageHeading} tabIndex={-1}>
        <PageHeader title="Settings" actions={<Button disabled={busy && loaded} onClick={onBack}>Back</Button>} />
      </div>
      <BoardSettings />
      {shared && <>
        {error && <StatusNotice kind="error">{error}</StatusNotice>}
        {notice && <StatusNotice>{notice}</StatusNotice>}
        {busy && !loaded && <p role="status">Loading Study settings…</p>}
        {(uncertain || reloadRequired || (!loaded && error)) &&
          <Button disabled={busy} onClick={load}>{uncertain ? "Check saved settings" : "Reload saved settings"}</Button>}
        {loaded && <form className="repertoire-form" onSubmit={save}>
          <fieldset disabled={!editable} className="settings-fields">
            <Surface>
              <section className="settings-group" aria-labelledby="study-settings">
                <h2 id="study-settings">Study</h2>
                <Limit label="New opening moves per day" value={draft.openings}
                  update={value => update("openings", value)} />
                <p>Study days begin at midnight in {saved.study_timezone.replaceAll("_", " ")}.</p>
              </section>
            </Surface>
            <Surface>
              <section className="settings-group" aria-labelledby="tactics-settings">
                <h2 id="tactics-settings" tabIndex={-1} ref={tacticHeading}>Tactics</h2>
                <div className="settings-number-fields">
                  <Limit label="New tactics per day" value={draft.tactics} update={value => update("tactics", value)} />
                  <Limit label="Extra tactics per request" value={draft.more} update={value => update("more", value)} />
                </div>
                <p>Set extra tactics to 0 to turn off Learn more tactics today.</p>
                <TacticThemes saved={saved} selection={draft.selection} update={value => update("selection", value)} />
              </section>
            </Surface>
          </fieldset>
          <div className="actions">
            <Button type="submit" variant="primary" pending={busy} disabled={!canSave}>Save Study settings</Button>
          </div>
        </form>}
      </>}
    </main>
  );
}

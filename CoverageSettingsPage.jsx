import React, { useEffect, useState } from "react";
import { Button, PageHeader, StatusNotice, Surface } from "@tempo-v2/core-components";
import { CoverageStartingLine } from "./CoverageStartingLine.jsx";
import { readRepertoireCatalog } from "./repertoire_commands.js";

export function CoverageSettingsPage({ onStudy }) {
  const [catalog, setCatalog] = useState(null);
  const [repertoire, setRepertoire] = useState("");
  const [settings, setSettings] = useState({});
  const [issue, setIssue] = useState("");
  useEffect(() => {
    const owner = new AbortController();
    readRepertoireCatalog(owner.signal).then(setCatalog, error => {
      if (!owner.signal.aborted) setIssue(error.message);
    });
    return () => owner.abort();
  }, []);
  return <main className="tempo-core">
    <PageHeader title="Coverage settings" />
    <Surface>
      {issue && <StatusNotice kind="error">{issue}</StatusNotice>}
      {catalog && <label>Repertoire
        <select value={repertoire} onChange={event => setRepertoire(event.target.value)}>
          <option value="">Choose a repertoire</option>
          {catalog.repertoires.filter(item => item.activity === "active").map(item =>
            <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>}
      {repertoire && <CoverageStartingLine key={repertoire} dataset={catalog.dataset_id}
        repertoire={repertoire} setting={settings[repertoire]}
        onSaved={saved => setSettings(current => ({ ...current, [repertoire]: saved }))} alwaysOpen />}
      <Button onClick={onStudy}>Back to Study</Button>
    </Surface>
  </main>;
}

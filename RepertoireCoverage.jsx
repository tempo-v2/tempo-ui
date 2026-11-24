import React, { useState } from "react";
import { CoverageStartingLine } from "./CoverageStartingLine.jsx";

export function coveragePercent(probability) {
  if (probability > 0 && probability < 0.001) return "<0.1%";
  if (probability < 1 && probability > 0.999) return ">99.9%";
  return `${Number((probability * 100).toFixed(1))}%`;
}

export function RepertoireCoverage({ dataset, repertoires, forecastBook, onFilter, onStartingLineSaved, phoneBuild }) {
  const [settings, setSettings] = useState({});
  const active = repertoires.filter(item => item.activity === "active");
  const selected = active.find(item => item.id === forecastBook);
  return <div className="repertoire-fields">
    <label>Repertoire
      <select value={selected?.id ?? ""} onChange={event => onFilter(event.target.value || null)}>
        <option value="">{phoneBuild ? "Choose a repertoire" : "All gaps"}</option>
        {active.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </label>
    {selected && <CoverageStartingLine key={selected.id} dataset={dataset} repertoire={selected.id}
      setting={settings[selected.id]} alwaysOpen onSaved={saved => {
        setSettings(current => ({ ...current, [selected.id]: saved }));
        onStartingLineSaved();
      }} />}
  </div>;
}

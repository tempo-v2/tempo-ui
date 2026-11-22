import React, { useEffect, useRef, useState } from "react";
import { Button, PageHeader, StatusNotice, Surface } from "@tempo-v2/core-components";
import { GapEditor } from "./GapEditor.jsx";
import { RepertoireCoverage, coveragePercent } from "./RepertoireCoverage.jsx";
import { gapDraft, readGaps } from "./game_commands.js";
import { gapAddress, gapKey, readGapContinuation } from "./gap_save.js";
import { readRepertoireCatalog } from "./repertoire_commands.js";

export function PhoneBuildPage() {
  const [catalog, setCatalog] = useState(null);
  const [issue, setIssue] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const owner = new AbortController();
    setIssue("");
    readRepertoireCatalog(owner.signal).then(setCatalog, error => {
      if (!owner.signal.aborted) setIssue(error.message);
    });
    return () => owner.abort();
  }, [retry]);

  return <main className="phone-build">
    <PageHeader title="Build repertoire" />
    {issue && <Surface>
      <StatusNotice kind="error">{issue}</StatusNotice>
      <Button onClick={() => setRetry(count => count + 1)}>Retry repertoires</Button>
    </Surface>}
    {!catalog && !issue && <p role="status">Loading repertoires…</p>}
    {catalog && <BuildWorkspace key={catalog.dataset_id} dataset={catalog.dataset_id} repertoires={catalog.repertoires} />}
  </main>;
}

async function readForecast(dataset, book, offset, signal) {
  const page = await readGaps(signal, offset, book);
  if (page.dataset_id !== dataset || page.gaps.some(gap =>
    gap.repertoire_id !== book || gap.gap_kind !== "forecast" || !gap.forecast?.report_id)) {
    throw new Error("The coverage gaps belong to a different repertoire or dataset.");
  }
  return page;
}

async function loadDraft(dataset, book, offset, gap, owner) {
  const address = gapAddress(dataset, gap);
  const details = await gapDraft(address, AbortSignal.any([owner, AbortSignal.timeout(5_000)]));
  return { address, details, offset, forecastBook: book, forecast: gap.forecast };
}

function BuildWorkspace({ dataset, repertoires }) {
  const [recovery] = useState(readGapContinuation);
  const [book, setBook] = useState(() => {
    const id = recovery?.gap.address.dataset_id === dataset ? recovery.gap.forecastBook : null;
    return repertoires.some(item => item.id === id && item.activity === "active") ? id : null;
  });
  const [activeGap, setActiveGap] = useState(recovery?.gap ?? null);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [results, setResults] = useState(null);
  const [notice, setNotice] = useState("");
  const [draftIssue, setDraftIssue] = useState("");
  const [opening, setOpening] = useState(false);
  const draftOwner = useRef(null);
  const editing = !!activeGap;
  const current = results?.book === book && results.offset === offset && results.revision === revision ? results : null;

  function refresh() {
    setRevision(count => count + 1);
  }

  useEffect(() => {
    if (!book || editing) return;
    const owner = new AbortController();
    readForecast(dataset, book, offset, owner.signal).then(page => {
      if (!owner.signal.aborted) setResults({ book, offset, revision, page });
    }, error => {
      if (!owner.signal.aborted) setResults({ book, offset, revision, issue: error.message });
    });
    return () => owner.abort();
  }, [book, dataset, editing, offset, revision]);

  function cancelDraft() {
    draftOwner.current?.abort();
    draftOwner.current = null;
  }

  useEffect(() => cancelDraft, []);

  function selectBook(id) {
    cancelDraft();
    setOpening(false);
    setBook(id);
    setOffset(0);
    setDraftIssue("");
    setNotice("");
  }

  async function openGap(gap) {
    cancelDraft();
    const owner = new AbortController();
    draftOwner.current = owner;
    setOpening(true);
    setDraftIssue("");
    setNotice("");
    try {
      const draft = await loadDraft(dataset, book, offset, gap, owner.signal);
      if (!owner.signal.aborted) setActiveGap(draft);
    } catch (error) {
      if (!owner.signal.aborted) setDraftIssue(error.message);
    } finally {
      if (draftOwner.current === owner) {
        draftOwner.current = null;
        setOpening(false);
      }
    }
  }

  async function advance(saved) {
    const { address, forecastBook } = activeGap;
    if (address.dataset_id !== dataset) {
      setNotice(`Saved ${saved} in the previous dataset.`);
      setActiveGap(null);
      return;
    }
    const signal = AbortSignal.timeout(12_000);
    const page = await readForecast(dataset, forecastBook, 0, signal);
    const next = page.gaps.find(gap => gapKey(gap) !== gapKey(address));
    const draft = next ? await loadDraft(dataset, forecastBook, 0, next, signal) : null;
    setOffset(0);
    setNotice(`Saved ${saved}.`);
    setActiveGap(draft);
    refresh();
  }

  const page = current?.page;
  return <>
    <Surface>
      <RepertoireCoverage dataset={dataset} repertoires={repertoires} forecastBook={book} onFilter={selectBook}
        onStartingLineSaved={refresh} phoneBuild />
      {!repertoires.some(item => item.activity === "active") && <p>Choose an active repertoire in Tempo on your Mac to get started.</p>}
    </Surface>
    {book && <Surface>
      <h2>Likely missing replies</h2>
      {notice && !editing && <StatusNotice>{notice}</StatusNotice>}
      {(current?.issue || draftIssue) && <>
        <StatusNotice kind="error">{current?.issue || draftIssue}</StatusNotice>
        <Button onClick={() => { setDraftIssue(""); refresh(); }}>Refresh gaps</Button>
      </>}
      {!current && !editing && <p role="status">Loading coverage gaps…</p>}
      {opening && <p role="status">Opening reply…</p>}
      {page?.gaps.length === 0 && <p>No open suggestions from saved coverage.</p>}
      {page?.gaps.length > 0 && <ol className="phone-build-gaps" start={offset + 1}>
        {page.gaps.map(gap => <li key={gapKey(gap)}>
          <div><strong>{gap.actual_san ?? "Opponent move"}</strong>
            <span>{coveragePercent(gap.forecast.probability)} first-gap chance{gap.forecast.stale && " · Earlier scan"}</span></div>
          <Button disabled={opening} onClick={() => void openGap(gap)}>Fix response</Button>
        </li>)}
      </ol>}
      {(page?.more || offset > 0) && <div className="actions">
        <Button disabled={!offset || opening} onClick={() => setOffset(offset - 100)}>Previous gaps</Button>
        <Button disabled={!page?.more || opening} onClick={() => setOffset(offset + 100)}>Next gaps</Button>
      </div>}
    </Surface>}
    {activeGap && <GapEditor key={gapKey(activeGap.address)} gap={activeGap} phoneBuild previousSave={notice}
      recovery={activeGap === recovery?.gap ? recovery : null} onAdvance={advance}
      onClose={saved => { if (saved) setNotice(`Saved ${saved}.`); setActiveGap(null); }}
      onStale={() => { setActiveGap(null); refresh(); }} />}
  </>;
}

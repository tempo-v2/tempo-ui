import { AnalysisPage } from "./AnalysisPage.jsx";
import React, { useEffect, useRef, useState } from "react";
import { Button, PageHeader, StatusNotice, Surface } from "@tempo-v2/core-components";
import {
  chooseGameCorrection, gameEffects, importGamePgn, reprocessGames, readGameHistory, readGameJob, refreshGames,
  sourceNames, utcDateRange, utcDayMs, gapDraft, historicalStatus, modelStatus,
  readGaps, retryHistorical, startHistorical, startModel,
} from "./game_commands.js";
import { readRepertoireCatalog } from "./repertoire_commands.js";
import { GapEditor } from "./GapEditor.jsx";
import { GameDetectionPanel } from "./GameDetectionPanel.jsx";
import { readGapContinuation } from "./gap_save.js";
import { commandRecovery } from "./content_transport.js";

function GameResults({ results, repertoires, history = false, onChoose, dataset }) {
  const [detectorRow, setDetectorRow] = useState(null);
  return (
    <ul className="game-results">
      {results.map((result, index) => {
        const repertoire = repertoires.find(item => item.id === result.repertoire_id);
        const source = Object.hasOwn(sourceNames, result.source) ? sourceNames[result.source] : "Game";
        const gameLink = `${source} game`;
        // Reports can repeat a comparison and legacy receipts may omit its ID.
        const key = history && result.comparison_id
          ? result.comparison_id
          : JSON.stringify([result.comparison_id, index]);
        return (
          <li key={key}>
            <div>
              {result.url
                ? <a href={result.url} target="_blank" rel="noopener noreferrer">{gameLink}</a>
                : <strong>{gameLink}</strong>}
              <span> · {result.learner}{result.repertoire_id && ` · ${repertoire?.name ?? result.repertoire_id}`}</span>
              {result.occurrence_end_ms !== null && (
                <span> · {new Date(result.occurrence_end_ms).toLocaleDateString()}</span>
              )}
            </div>
            <p className="game-result-effect">{gameEffects[result.effect]}</p>
            {result.first_deviation_ply !== null && (
              <p><strong>First learner deviation on half-move {result.first_deviation_ply}</strong></p>
            )}
            {result.disagreements.length > 0 && (
              <details>
                <summary>Disagreements by repertoire</summary>
                <ul>{result.disagreements.map(item => (
                  <li key={item.repertoire_id}>
                    {repertoires.find(book => book.id === item.repertoire_id)?.name ?? item.repertoire_id}
                    {" · "}{item.plies.length} {item.plies.length === 1 ? "move" : "moves"}
                  </li>
                ))}</ul>
              </details>
            )}
            {result.repertoires?.length > 0 && (
              <details>
                <summary>Repertoire compatibility</summary>
                <ul>{result.repertoires.map(book => (
                  <li key={book.repertoire_id}>
                    <strong>{repertoires.find(item => item.id === book.repertoire_id)?.name ?? book.repertoire_id}</strong>
                    {" · "}{book.source_available
                      ? book.first_departure ? `${departureLabels[book.first_departure.kind]} on half-move ${book.first_departure.ply}` : "Compatible through the played line"
                      : "Authored context unavailable"}
                    {book.reentry_ply && ` · Reentered on half-move ${book.reentry_ply}`}
                  </li>
                ))}</ul>
              </details>
            )}
            {onChoose && result.choices.map(choice => (
              <div className="actions" key={choice.ply}>
                <span>Corrective target for half-move {choice.ply}</span>
                {choice.candidates.map(candidate => (
                  <Button key={candidate.target_id} onClick={() => onChoose(result, choice, candidate)}>
                    {repertoires.find(book => book.id === candidate.repertoire_id)?.name ?? candidate.repertoire_id}
                  </Button>
                ))}
              </div>
            ))}
            <p>{result.matches} matched · {result.deviations} learner misses · {result.opponent_deviations} opponent deviations · {result.coverage_gaps} outside coverage</p>
            {history && dataset && (
              <>
                <Button onClick={() => setDetectorRow(detectorRow === key ? null : key)}
                  aria-expanded={detectorRow === key}>
                  {detectorRow === key ? "Close detector" : "Analyze this game"}
                </Button>
                {detectorRow === key && (
                  <GameDetectionPanel key={JSON.stringify([dataset, result.source, result.game_id, result.learner])}
                    dataset={dataset} source={result.source} gameId={result.game_id} learner={result.learner} />
                )}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const departureLabels = {
  learner_move: "Learner departure",
  opponent_gap: "Opponent coverage gap",
  authored_endpoint: "Authored line ended",
  outside_context: "Outside authored context",
};

const utcDate = time => new Date(time).toISOString().slice(0, 10);

function HistoricalImport({ job, disabled, onStart, onRetry }) {
  const today = Math.floor(Date.now() / utcDayMs) * utcDayMs;
  const state = job?.status;
  const active = job?.windows?.[job.active_window];
  return (
    <Surface>
      <h2>Historical backfill</h2>
      <form className="repertoire-form" onSubmit={onStart}>
        <fieldset disabled={disabled || ["running", "paused"].includes(state)}>
          <div className="repertoire-fields">
            <label>Lichess account <input name="lichess" maxLength={40} defaultValue={job?.request?.lichess ?? ""} /></label>
            <label>Chess.com account <input name="chess_com" maxLength={40} defaultValue={job?.request?.chess_com ?? ""} /></label>
          </div>
          <p>Accounts entered here stay recognized. Leave a provider blank to skip it for this import.</p>
          <div className="repertoire-fields">
            <label>First day (UTC) <input type="date" name="from" defaultValue={utcDate(today - 90 * utcDayMs)} required /></label>
            <label>Last day (UTC) <input type="date" name="to" defaultValue={utcDate(today - utcDayMs)}
              max={utcDate(today - utcDayMs)} required /></label>
          </div>
          <p>Qualifying historical misses can add new Game Agains. A later repertoire reset stops this job from adding more for that repertoire.</p>
          <Button type="submit">Start historical backfill</Button>
        </fieldset>
      </form>
      {job?.windows && (
        <div>
          <p role="status">{job.windows.filter(window => window.status === "complete").length} complete · {job.incomplete_windows} incomplete · {job.pending_windows} pending</p>
          {active && <p>Processing {sourceNames[active.source]} · {active.learner} · {utcDate(active.from_ms)} to {utcDate(active.to_ms - 1)}</p>}
          {job.error && <StatusNotice kind="error">{job.error}</StatusNotice>}
          {(state === "incomplete" || state === "paused") &&
            <Button disabled={disabled} onClick={onRetry}>Retry remaining windows</Button>}
          <details>
            <summary>Provider windows</summary>
            <ul className="game-results">{job.windows.map(window => (
              <li key={`${window.source}:${window.learner}:${window.from_ms}`}>
                <strong>{sourceNames[window.source]} · {window.learner} · {utcDate(window.from_ms)} to {utcDate(window.to_ms - 1)}</strong>
                <p>{window.status} · {window.accepted} processed of {window.received} returned{window.split && " · split after provider limit"}</p>
                {window.notes.length > 0 && <ul>{window.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
              </li>
            ))}</ul>
          </details>
        </div>
      )}
    </Surface>
  );
}

function GameReport({ report, importing, repertoires }) {
  return (
    <>
      <dl className="content-preview">
        <dt>{importing ? "Games read" : "Games fetched"}</dt><dd>{report.fetched}</dd>
        <dt>New games</dt><dd>{report.new_games}</dd>
        <dt>Duplicates</dt><dd>{report.duplicates}</dd>
        {report.opposite_color_skipped > 0 && (
          <><dt>Skipped for opposite color</dt><dd>{report.opposite_color_skipped}</dd></>
        )}
        <dt>Matched positions</dt><dd>{report.matches}</dd>
        <dt>Learner deviations</dt><dd>{report.deviations}</dd>
      </dl>
      {report.errors.length > 0 && (
        <StatusNotice kind="error">
          <strong>{report.errors.length} {report.errors.length === 1 ? "problem" : "problems"} reported</strong>
          <ul>{report.errors.map((error, index) => <li key={index}>{error}</li>)}</ul>
        </StatusNotice>
      )}
      <GameResults results={report.results} repertoires={repertoires} />
    </>
  );
}

const gameRecovery = commandRecovery("tempo.games.pending.v1");
const evidencePollMs = 2000;
const gapDraftTimeoutMs = 5000;

const recoverableGameKinds = new Set(["import", "refresh", "choose", "reprocess", "backfill", "backfill-retry"]);

async function loadPendingGame() {
  const command = await gameRecovery.load({ strict: true });
  if (command === null) return null;
  if (!recoverableGameKinds.has(command?.kind) ||
      typeof command.payload?.command_id !== "string" || !command.payload.command_id ||
      typeof command.payload.dataset_id !== "string" || !command.payload.dataset_id)
    throw new TypeError("The saved Games request is invalid.");
  return command;
}

function matchesRefresh(job, command) {
  return command?.kind === "refresh" && job?.datasetId === command.payload.dataset_id &&
    job.commandId === command.payload.command_id;
}

function evidenceFor(resource, dataset, offset) {
  return resource?.dataset === dataset && resource.offset === offset ? resource : undefined;
}

function gapKey(gap) {
  return JSON.stringify([gap.repertoire_id, gap.position, gap.actual_move]);
}

export function GamesPage({ onStudy, onRepertoires }) {
  const [source, setSource] = useState("lichess");
  const [repertoires, setRepertoires] = useState(null);
  const [dataset, setDataset] = useState(null);
  const [pendingEntry, setPendingEntry] = useState(null);
  const [recoveryStatus, setRecoveryStatus] = useState("loading");
  const [cleanupIssue, setCleanupIssue] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const [history, setHistory] = useState(null);
  const [historyError, setHistoryError] = useState("");
  const [observedJob, setJob] = useState(null);
  const [jobError, setJobError] = useState("");
  const [evidence, setEvidence] = useState({});
  const [modelActionError, setModelActionError] = useState("");
  const [modelActionDataset, setModelActionDataset] = useState(null);
  const [gapActionError, setGapActionError] = useState("");
  const [analysis,setAnalysis] = useState(null);
  const [workingGap, setWorkingGap] = useState(false);
  const [recovery] = useState(readGapContinuation);
  const [gapOffset, setGapOffset] = useState(() => recovery?.gap.offset ?? 0);
  const [activeGap, setActiveGap] = useState(() => recovery?.gap ?? null);
  const [gapNotice, setGapNotice] = useState("");
  const [evidenceRevision, setEvidenceRevision] = useState(0);
  const [importResult, setImportResult] = useState(null);
  const [refreshResult, setRefreshResult] = useState(null);
  const [issue, setIssue] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [jobRevision, setJobRevision] = useState(0);
  const lifecycle = useRef(null);
  const evidenceOwner = useRef(null);
  const historyOwner = useRef(null);
  const catalogDataset = useRef(null);
  const observedRunning = useRef({ dataset: null });
  const acknowledgedRetry = useRef(null);
  const modelAction = useRef(null);
  const inFlight = useRef(false);
  const importing = source === "pgn";
  const job = observedJob?.datasetId && observedJob.datasetId !== dataset ? null : observedJob;
  const refreshing = job?.status === "running";
  const pending = pendingEntry?.command;
  const acceptedCleanup = pendingEntry?.phase === "accepted";
  const commandsBlocked = recoveryStatus !== "ready" || !!pending;
  const sameRefreshRunning = refreshing && matchesRefresh(job, pending);
  const importReport = importResult?.datasetId === dataset ? importResult.report : null;
  const confirmedRefresh = refreshResult?.datasetId === dataset ? refreshResult : null;
  const shownAsCurrent = job?.status === "complete" && confirmedRefresh?.commandId === job.commandId;
  const report = importReport ?? job?.report;
  const refreshFailed = !importReport && job?.status === "failed";
  const backfillRead = evidenceFor(evidence.backfill, dataset);
  const modelRead = evidenceFor(evidence.model, dataset);
  const gapRead = evidenceFor(evidence.gaps, dataset, gapOffset);
  const backfill = backfillRead?.value;
  const model = modelRead?.value;
  const projection = modelRead?.projection;
  const gapPage = gapRead?.value;
  const evidenceErrors = [
    ["Historical backfill status", backfillRead?.error],
    ["Maia run status", modelRead?.error],
    ["Opponent gaps", gapRead?.error],
  ].filter(([, message]) => message);

  function updateEvidence(name, changes, offset) {
    setEvidence(current => ({
      ...current,
      [name]: { ...evidenceFor(current[name], dataset, offset), dataset, offset, ...changes },
    }));
  }

  function recordJobStatus(name, value, readChanges) {
    if (observedRunning.current.dataset !== dataset) observedRunning.current = { dataset };
    const activity = observedRunning.current;
    const running = value.status === "running";
    let settled = activity[name] && !running;
    if (name === "backfill") {
      const hasSettlement = ["complete", "incomplete", "paused"].includes(value.status);
      if (hasSettlement) {
        // A Retry can advance a different window without changing the maximum attempt.
        // Paused work may have already committed batches of a still-pending window.
        const settlement = JSON.stringify([value.job_id, value.status, value.windows.map(window => [
          window.source, window.learner, window.from_ms, window.to_ms, window.attempt, window.status,
        ])]);
        // A local Retry can commit batches and pause again between status reads.
        const retry = acknowledgedRetry.current;
        if (retry?.dataset === dataset && retry.jobId === value.job_id) {
          acknowledgedRetry.current = null;
          settled = true;
        }
        settled = settled || settlement !== activity.backfillSettlement;
        activity.backfillSettlement = settlement;
      } else {
        settled = false;
      }
    }
    activity[name] = running;
    updateEvidence(name, { value, ...readChanges });
    if (settled) refreshHistory();
    return settled;
  }

  function refreshHistory() {
    historyOwner.current?.abort();
    setHistoryRevision(revision => revision + 1);
  }

  function refreshEvidenceReads() {
    evidenceOwner.current?.abort();
    setEvidenceRevision(value => value + 1);
  }

  useEffect(() => {
    lifecycle.current = new AbortController();
    return () => lifecycle.current?.abort();
  }, []);

  useEffect(() => {
    const owner = new AbortController();
    setCatalogError("");
    readRepertoireCatalog(owner.signal).then(reply => {
      if (!owner.signal.aborted) {
        if (acknowledgedRetry.current?.dataset !== reply.dataset_id) acknowledgedRetry.current = null;
        if (catalogDataset.current !== null && catalogDataset.current !== reply.dataset_id) {
          evidenceOwner.current?.abort();
          historyOwner.current?.abort();
          modelAction.current = null;
          setModelActionDataset(null);
          setModelActionError("");
          setHistory(null);
          setJob(null);
          setHistoryError("");
          refreshHistory();
        }
        catalogDataset.current = reply.dataset_id;
        setRepertoires(reply.repertoires);
        setDataset(reply.dataset_id);
      }
    }).catch(error => {
      if (!owner.signal.aborted) setCatalogError(error.message || "Could not load repertoires.");
    });
    return () => owner.abort();
  }, [reload]);

  useEffect(() => {
    const request = new AbortController();
    historyOwner.current = request;
    setHistoryError("");
    readGameHistory(request.signal).then(next => {
      if (!request.signal.aborted) setHistory(next);
    }).catch(error => {
      if (!request.signal.aborted) setHistoryError(error.message || "Could not load game history.");
    });
    return () => request.abort();
  }, [reload, historyRevision]);

  useEffect(() => {
    if (!dataset) return;
    const request = new AbortController();
    let timer;
    async function check() {
      try {
        const next = await readGameJob(request.signal);
        if (request.signal.aborted || dataset !== catalogDataset.current) return;
        setJobError("");
        // A physical worker from a replaced dataset can still be finishing.
        // Its slot has no current-dataset result to display.
        setJob(next.datasetId && next.datasetId !== dataset ? { status: "idle" } : next);
        if (next.status === "running") timer = setTimeout(check, 1000);
        else {
          refreshHistory();
          if (next.datasetId === dataset) refreshEvidenceReads();
        }
      } catch (error) {
        if (!request.signal.aborted && dataset === catalogDataset.current) {
          setJobError(error.message || "Could not check the refresh.");
          timer = setTimeout(check, 1500);
        }
      }
    }
    void check();
    return () => {
      request.abort();
      clearTimeout(timer);
    };
  }, [dataset, jobRevision]);

  useEffect(() => {
    if (!dataset) return;
    const owner = new AbortController();
    evidenceOwner.current = owner;
    let pendingProjection = false;
    let refreshGaps = false;

    function observeStatus(name, value, readChanges) {
      if (recordJobStatus(name, value, { error: "", ...readChanges })) {
        refreshGaps = true;
      }
    }

    const resources = [
      {
        name: "backfill",
        read: historicalStatus,
        apply(value) {
          if (value.status !== "idle" && value.request?.dataset_id !== dataset) {
            throw new Error("Historical backfill belongs to a different dataset.");
          }
          observeStatus("backfill", value);
        },
      },
      {
        name: "model",
        read: modelStatus,
        apply(value) {
          if (value.status !== "idle" && value.dataset_id !== dataset)
            throw new Error("Maia run status belongs to a different dataset.");
          const summary = value.projection?.dataset_id === dataset ? value.projection : undefined;
          pendingProjection = summary?.pending > 0;
          observeStatus("model", value, { projection: summary });
          const action = modelAction.current;
          if (action?.dataset === dataset && action.reconciling) {
            modelAction.current = null;
            setModelActionDataset(null);
          }
        },
      },
      {
        name: "gaps",
        offset: gapOffset,
        read(signal) {
          refreshGaps = false;
          return readGaps(signal, gapOffset);
        },
        apply(value) {
          if (value.dataset_id !== dataset) throw new Error("Opponent gaps belong to a different dataset.");
          if (!Array.isArray(value.gaps)) throw new Error("Invalid opponent gaps response.");
          updateEvidence("gaps", { value, error: "" }, gapOffset);
        },
      },
    ];

    function shouldPoll(resource) {
      const activity = observedRunning.current;
      const running = activity.dataset === dataset && (activity.backfill || activity.model);
      return resource.failed || running || pendingProjection || (resource.name === "gaps" && refreshGaps);
    }

    function schedule() {
      if (owner.signal.aborted) return;
      for (const resource of resources) {
        if (resource.reading || resource.timer !== undefined || !shouldPoll(resource)) continue;
        resource.timer = setTimeout(() => {
          resource.timer = undefined;
          if (!owner.signal.aborted && shouldPoll(resource)) void check(resource);
        }, evidencePollMs);
      }
    }

    // Each resource publishes and reschedules as soon as its own request settles.
    async function check(resource) {
      resource.reading = true;
      try {
        const next = await resource.read(owner.signal);
        if (!owner.signal.aborted) {
          resource.apply(next);
          resource.failed = false;
        }
      } catch (error) {
        if (!owner.signal.aborted) {
          resource.failed = true;
          updateEvidence(resource.name, { error: error.message || "Could not load this evidence." }, resource.offset);
        }
      } finally {
        resource.reading = false;
        schedule();
      }
    }

    for (const resource of resources) void check(resource);
    return () => {
      owner.abort();
      for (const resource of resources) clearTimeout(resource.timer);
    };
  }, [dataset, evidenceRevision, gapOffset]);

  function beginBackfill(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run(() => ({ kind: "backfill", payload: {
      command_id: crypto.randomUUID(), dataset_id: dataset,
      lichess: form.get("lichess").trim() || null,
      chess_com: form.get("chess_com").trim() || null,
      ...utcDateRange(form.get("from"), form.get("to"), 366),
    } }));
  }

  async function analyze() {
    if (!dataset || modelAction.current || model?.status === "running") return;
    const signal = lifecycle.current.signal;
    const action = { dataset, reconciling: false };
    modelAction.current = action;
    setModelActionDataset(dataset);
    setModelActionError("");
    const current = () => !signal.aborted && modelAction.current === action && dataset === catalogDataset.current;
    try {
      const status = await startModel({ dataset_id: dataset }, signal);
      if (current()) {
        refreshEvidenceReads();
        recordJobStatus("model", status);
      }
    } catch (error) {
      if (current()) {
        // The run may have started. Reconcile its status before permitting
        // another explicit start, even if the original reply arrives late.
        action.reconciling = true;
        setModelActionError(`Tempo could not confirm the Maia start. ${error.message}`);
        refreshEvidenceReads();
      }
    } finally {
      if (current() && !action.reconciling) {
        modelAction.current = null;
        setModelActionDataset(null);
      }
    }
  }

  async function loadGap(gap, passed, offset, signal, datasetId = dataset) {
    const address = {
      dataset_id: datasetId, repertoire_id: gap.repertoire_id, position: gap.position,
      actual_move: gap.actual_move, document_revision: gap.document_revision,
    };
    const details = await gapDraft(address, AbortSignal.any([signal, AbortSignal.timeout(gapDraftTimeoutMs)]));
    if (!signal.aborted) setActiveGap({ address, details, passed, offset });
  }

  async function openGap(gap, index) {
    const signal = lifecycle.current.signal;
    setGapActionError("");
    setGapNotice("");
    setWorkingGap(true);
    try {
      await loadGap(gap, gapPage.gaps.slice(0, index + 1).map(gapKey), gapOffset, signal);
    } catch (error) {
      if (!signal.aborted) {
        setGapActionError(error.message);
        refreshEvidenceReads();
      }
    } finally {
      if (!signal.aborted) setWorkingGap(false);
    }
  }

  async function advanceGap(san) {
    const signal = lifecycle.current.signal;
    const { address, passed, offset } = activeGap;
    async function freshPage(pageOffset) {
      const page = await readGaps(signal, pageOffset);
      if (page.dataset_id !== address.dataset_id) throw new Error("The active dataset changed.");
      if (page.gaps.some(gap => gapKey(gap) === gapKey(address)))
        throw new Error("Tempo could not confirm the refreshed gap list. Try loading it again.");
      return page;
    }
    let nextOffset = offset;
    let page = await freshPage(nextOffset);
    // Stable gap identity keeps earlier rows from becoming the next task when ranks shift.
    let index = page.gaps.findIndex(gap => !passed.includes(gapKey(gap)));
    if (index < 0 && page.more) {
      nextOffset += 100;
      page = await freshPage(nextOffset);
      index = page.gaps.findIndex(gap => !passed.includes(gapKey(gap)));
    }
    if (signal.aborted) return;
    if (!page.gaps.length && nextOffset > 0) nextOffset -= 100;
    refreshEvidenceReads();
    if (page.gaps.length || nextOffset === 0) updateEvidence("gaps", { value: page, error: "" }, nextOffset);
    setGapOffset(nextOffset);
    if (index >= 0) await loadGap(page.gaps[index], page.gaps.slice(0, index + 1).map(gapKey), nextOffset, signal, address.dataset_id);
    else {
      setActiveGap(null);
      setGapNotice(`Saved ${san}.`);
    }
  }

  useEffect(() => {
    if (recoveryStatus !== "loading") return;
    let current = true;
    loadPendingGame().then(command => {
      if (!current) return;
      setPendingEntry(command ? { command, phase: "saved" } : null);
      setRecoveryStatus("ready");
    }).catch(() => {
      if (current) setRecoveryStatus("blocked");
    });
    return () => { current = false; };
  }, [recoveryStatus]);

  async function clearPending({ accepted = false, unsaved = false } = {}) {
    try {
      const { orphaned } = unsaved ? { orphaned: false } : await gameRecovery.clear();
      setPendingEntry(null);
      setRecoveryStatus("ready");
      setIssue("");
      setCleanupIssue(orphaned ? "The saved Games request was cleared. Its unused storage could not be removed." : "");
    } catch {
      setCleanupIssue(accepted
        ? "Tempo confirmed this Games request, but could not clear its saved recovery record."
        : "Tempo could not dismiss the saved Games request.");
    }
  }

  async function cleanup(options) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await clearPending(options);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function owns(command, signal) {
    return !signal.aborted && command.payload.dataset_id === catalogDataset.current;
  }

  async function settle(command, reply) {
    if (command.kind === "refresh") setRefreshResult(reply);
    setPendingEntry({ command, phase: "accepted" });
    setIssue("");
    await clearPending({ accepted: true });
  }

  async function deliver(command, signal) {
    if (command.kind === "backfill" || command.kind === "backfill-retry") {
      const submit = command.kind === "backfill" ? startHistorical : retryHistorical;
      await submit(command.payload, signal);
      if (!owns(command, signal)) return;
      // The acknowledged historical job may be older than the current slot.
      if (command.kind === "backfill-retry") {
        const { dataset_id, job_id } = command.payload;
        acknowledgedRetry.current = { dataset: dataset_id, jobId: job_id };
      }
      refreshEvidenceReads();
      await settle(command);
    } else if (command.kind !== "refresh") {
      const submitGame = { import: importGamePgn, choose: chooseGameCorrection, reprocess: reprocessGames }[command.kind];
      const result = await submitGame(command.payload, signal);
      if (!owns(command, signal)) return;
      setImportResult({ datasetId: command.payload.dataset_id, report: result });
      refreshHistory();
      refreshEvidenceReads();
      await settle(command);
    } else {
      const reply = await refreshGames(command.payload, signal);
      if (!owns(command, signal)) return;
      if (reply.status === "complete") {
        refreshHistory();
        refreshEvidenceReads();
        await settle(command, reply);
      } else setJobRevision(revision => revision + 1);
    }
  }

  useEffect(() => {
    if (pendingEntry?.phase !== "saved" || inFlight.current ||
        job?.status !== "complete" || !matchesRefresh(job, pending) ||
        job.datasetId !== catalogDataset.current) return;
    inFlight.current = true;
    setBusy(true);
    void settle(pending, job).finally(() => {
      inFlight.current = false;
      setBusy(false);
    });
  }, [job, pendingEntry, busy]);

  async function run(build, { recovering = false } = {}) {
    if (recoveryStatus !== "ready" || !dataset || inFlight.current) return;
    if (recovering) {
      if (!pending || acceptedCleanup || pending.payload.dataset_id !== dataset) return;
    } else if (pending || refreshing || !job || jobError) return;
    const signal = lifecycle.current.signal;
    inFlight.current = true;
    setBusy(true);
    setIssue("");
    setCleanupIssue("");
    setImportResult(null);
    let command;
    try {
      command = await build();
      if (!owns(command, signal)) return;
      if (!recovering || pendingEntry.phase === "unsaved") {
        setPendingEntry({ command, phase: "unsaved" });
        try {
          await gameRecovery.save(command);
        } catch {
          if (owns(command, signal)) setIssue("Tempo could not save this Games request for recovery. Nothing was sent.");
          return;
        }
        if (!signal.aborted) setPendingEntry({ command, phase: "saved" });
      }
      if (owns(command, signal)) await deliver(command, signal);
    } catch (error) {
      if (!signal.aborted && dataset === catalogDataset.current) {
        setIssue(error.message || "Could not process these games.");
        if (command) {
          refreshHistory();
          refreshEvidenceReads();
          setJobRevision(revision => revision + 1);
        }
      }
    } finally {
      inFlight.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }

  function submit(event) {
    event.preventDefault();
    if (pending || refreshing) return;
    const form = new FormData(event.currentTarget);
    void run(async () => {
      if (!dataset) throw new Error("Tempo could not identify the dataset.");
      const learner = form.get("learner").trim();
      if (!learner) throw new Error("Enter the learner’s account name.");
      const identity = { command_id: crypto.randomUUID(), dataset_id: dataset };
      if (importing) {
        const file = form.get("file");
        const pgn = file.size ? await file.text() : form.get("pgn");
        if (!pgn.trim()) throw new Error("Choose a PGN file or paste a completed game.");
        if (file.size && form.get("pgn").trim())
          throw new Error("Choose either a PGN file or pasted PGN.");
        return { kind: "import", payload: { ...identity, learner, pgn } };
      }
      const range = utcDateRange(form.get("from"), form.get("to"));
      if (source === "stored") return { kind: "reprocess", payload: { ...identity, learner, ...range } };
      return { kind: "refresh", payload: { ...identity, source, account: learner, ...range } };
    });
  }

  function choose(result, choice, candidate) {
    if (pending || refreshing || !dataset) return;
    void run(() => ({ kind: "choose", payload: {
      command_id: crypto.randomUUID(), dataset_id: dataset, learner: result.learner,
      source: result.source, game_id: result.game_id, comparison_id: result.comparison_id,
      ply: choice.ply, target_id: candidate.target_id,
    } }));
  }

  const now = new Date();
  const lastDate = now.toISOString().slice(0, 10);
  const firstDate = new Date(now.getTime() - 6 * utcDayMs).toISOString().slice(0, 10);
  function returnFromAnalysis(saved) {
    setAnalysis(null);
    if (saved) {
      setActiveGap(null);
      refreshEvidenceReads();
    }
  }
  return <div className="tempo-core">
    {analysis ? <AnalysisPage origin={analysis} onClose={returnFromAnalysis} /> : (
    <main className="tempo-core repertoire-page games-page">
      <PageHeader title="Games" actions={<Button onClick={onStudy}>Study</Button>} />
      <Surface>
        <h2>Compare completed games</h2>
        {catalogError && <StatusNotice kind="error">{catalogError}</StatusNotice>}
        {repertoires?.length === 0 && (
          <p>Save a repertoire before comparing games. <Button onClick={onRepertoires}>Repertoires</Button></p>
        )}
        <form className="repertoire-form" onSubmit={submit}>
          <fieldset disabled={busy || commandsBlocked || refreshing || !dataset}>
            <div className="repertoire-fields">
              <label>Source <select value={source} onChange={event => setSource(event.target.value)}>
                {Object.entries(sourceNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                <option value="stored">Saved games</option>
              </select></label>
              <label>{importing || source === "stored" ? "Learner name" : "Account name"}
                <input key={source} name="learner" required autoComplete="off" maxLength={128} />
              </label>
            </div>
            {importing ? (
              <>
                <label>PGN file <input type="file" name="file" accept=".pgn,.txt,application/x-chess-pgn,text/plain" /></label>
                <label>Or paste PGN <textarea name="pgn" rows={5} /></label>
              </>
            ) : (
              <div className="repertoire-fields">
                <label>First day (UTC) <input type="date" name="from" defaultValue={firstDate} max={lastDate} required /></label>
                <label>Last day (UTC) <input type="date" name="to" defaultValue={lastDate} max={lastDate} required /></label>
              </div>
            )}
            {source === "chess_com" && <p className="game-source-note">Chess.com archives may take up to 12 hours to update.</p>}
            <div className="actions">
              <Button type="submit" pending={busy && !refreshing}
                disabled={busy || refreshing || !job || !!jobError}>
                {importing ? "Import games" : source === "stored" ? "Reprocess saved games" : "Refresh games"}
              </Button>
            </div>
          </fieldset>
        </form>
        {issue && <StatusNotice kind="error">{issue}</StatusNotice>}
        {cleanupIssue && <StatusNotice kind="error">{cleanupIssue}</StatusNotice>}
        {recoveryStatus === "blocked" && (
          <div className="actions">
            <StatusNotice kind="error">Tempo could not read the pending Games request.</StatusNotice>
            <Button disabled={busy} onClick={() => setRecoveryStatus("loading")}>Retry recovery</Button>
            <Button disabled={busy} onClick={() => void cleanup()}>Dismiss pending request</Button>
          </div>
        )}
        {acceptedCleanup && !busy && (
          <Button onClick={() => void cleanup({ accepted: true })}>Retry cleanup</Button>
        )}
        {pending && !acceptedCleanup && !busy && !sameRefreshRunning && (!refreshing || pending.kind === "refresh") && (
          <div className="actions">
            {dataset && pending.payload.dataset_id !== dataset && (
              <StatusNotice kind="error">The pending Games request belongs to a different dataset.</StatusNotice>
            )}
            <Button disabled={!dataset || pending.payload.dataset_id !== dataset}
              onClick={() => void run(() => pending, { recovering: true })}>Retry same request</Button>
            <Button onClick={() => void cleanup({ unsaved: pendingEntry.phase === "unsaved" })}>Dismiss pending request</Button>
          </div>
        )}
        {jobError && <StatusNotice kind="error">{jobError}</StatusNotice>}
        {refreshing && !jobError && <p role="status">Refreshing games. You can return to Study while this runs.</p>}
        {(catalogError || jobError) && (
          <Button onClick={() => {
            setJob(null);
            setJobRevision(value => value + 1);
            historyOwner.current?.abort();
            setReload(value => value + 1);
            refreshEvidenceReads();
          }}>Reload Games</Button>
        )}
      </Surface>
      <HistoricalImport key={backfill?.job_id ?? "idle"} job={backfill}
        disabled={!dataset || busy || commandsBlocked || refreshing} onStart={beginBackfill}
        onRetry={() => void run(() => ({ kind: "backfill-retry", payload: {
          command_id: crypto.randomUUID(), dataset_id: dataset, job_id: backfill.job_id,
        } }))} />
      <Surface>
        <h2>Opponent coverage gaps</h2>
        <div className="actions">
          <Button disabled={!dataset || modelActionDataset === dataset || model?.status === "running"}
            onClick={() => void analyze()}>
            Analyze Maia probabilities
          </Button>
        </div>
        {model && model.status !== "idle" && (
          <p role="status">{model.profile} · {model.status} · {model.completed} of {model.total} positions
            {model.error && ` · ${model.error}`}</p>
        )}
        {projection && (
          <p role="status">Modeled reach · {projection.complete_current} complete · {projection.partial_current} partial
            {" · "}{projection.unavailable} unavailable · {projection.pending} pending</p>
        )}
        {modelActionError && <StatusNotice kind="error">{modelActionError}</StatusNotice>}
        {gapNotice && <StatusNotice>{gapNotice}</StatusNotice>}
        {gapActionError && <StatusNotice kind="error">{gapActionError}</StatusNotice>}
        {evidenceErrors.map(([label, message]) => (
          <StatusNotice key={label} kind="error">{label} · {message}</StatusNotice>
        ))}
        {evidenceErrors.length > 0 && <Button onClick={refreshEvidenceReads}>Retry evidence reads</Button>}
        {(gapPage?.more || gapOffset > 0) && <div className="actions">
          <Button disabled={gapOffset === 0 || workingGap} onClick={() => setGapOffset(offset => offset - 100)}>Previous gaps</Button>
          <Button disabled={!gapPage?.more || workingGap} onClick={() => setGapOffset(offset => offset + 100)}>Next gaps</Button>
        </div>}
        {!gapPage && !gapRead?.error && <p role="status">Loading opponent gaps…</p>}
        {gapPage?.gaps.length === 0 && <p>No confirmed opponent gaps in the current documents.</p>}
        {gapPage?.gaps.length > 0 && (
          <ul className="game-results">{gapPage.gaps.map((gap, index) => (
            <li key={gapKey(gap)}>
              <strong>{repertoires?.find(book => book.id === gap.repertoire_id)?.name ?? gap.repertoire_id}</strong>
              <p>{gap.actual_san ?? "Opponent move"} · {gap.games} {gap.games === 1 ? "game" : "games"}</p>
              <Button disabled={workingGap || !dataset} onClick={() => void openGap(gap, index)}>Fix response</Button>
            </li>
          ))}</ul>
        )}
      </Surface>
      {confirmedRefresh && (!shownAsCurrent || importReport) && (
        <Surface>
          <h2>Recovered refresh results</h2>
          <GameReport report={confirmedRefresh.report} importing={false} repertoires={repertoires ?? []} />
        </Surface>
      )}
      {(refreshFailed || report) && (
        <Surface>
          <h2>{importReport ? "Import results" : "Latest refresh"}</h2>
          {refreshFailed && <StatusNotice kind="error">{job.error}</StatusNotice>}
          {report && <GameReport report={report} importing={!!importReport} repertoires={repertoires ?? []} />}
        </Surface>
      )}
      <Surface>
        <h2>Game evidence</h2>
        {history?.lastSuccessfulRefresh != null ? (
          <p>Last successful provider refresh · {new Date(history.lastSuccessfulRefresh).toLocaleString()}</p>
        ) : history && <p>No successful provider refresh recorded.</p>}
        {historyError && (
          <>
            <StatusNotice kind="error">{historyError}</StatusNotice>
            <Button onClick={refreshHistory}>Reload game evidence</Button>
          </>
        )}
        {history ? history.results.length > 0
          ? <GameResults key={dataset} dataset={dataset} history onChoose={commandsBlocked || busy || refreshing ? undefined : choose} results={history.results} repertoires={repertoires ?? []} />
          : <p>No games recorded yet.</p>
          : !historyError && <p role="status">Loading game evidence…</p>}
      </Surface>
    </main>)}
      {activeGap && (
        <GapEditor key={gapKey(activeGap.address)} gap={activeGap} suspended={!!analysis} onAnalyze={setAnalysis}
          recovery={activeGap === recovery?.gap ? recovery : null} onAdvance={advanceGap}
          onClose={san => {
            setActiveGap(null);
            if (san) setGapNotice(`Saved ${san}.`);
          }}
          onStale={() => {
            setActiveGap(null);
            refreshEvidenceReads();
          }} />
      )}
  </div>;
}

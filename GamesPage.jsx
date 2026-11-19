import React, { useEffect, useRef, useState } from "react";
import { Button, PageHeader, StatusNotice, Surface } from "@tempo-v2/core-components";
import {
  chooseGameCorrection, gameEffects, importGamePgn, reprocessGames, maxGameCommandBytes, readGameHistory, readGameJob, refreshGames,
  sourceNames, utcDateRange, utcDayMs, gapDraft, historicalStatus, modelStatus,
  readGaps, retryHistorical, startHistorical, startModel,
} from "./game_commands.js";
import { sendRepertoireCommand } from "./repertoire_commands.js";

function GameResults({ results, repertoires, history = false, onChoose }) {
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
            {result.repertoires.length > 0 && (
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

const pendingKey = "tempo.games.pending.v1";

function pendingGame() {
  try { return JSON.parse(sessionStorage.getItem(pendingKey)); }
  catch { return null; }
}

export function GamesPage({ onStudy, onRepertoires, onGap }) {
  const [source, setSource] = useState("lichess");
  const [repertoires, setRepertoires] = useState(null);
  const [dataset, setDataset] = useState(null);
  const [pending, setPending] = useState(pendingGame);
  const [catalogError, setCatalogError] = useState("");
  const [history, setHistory] = useState(null);
  const [historyError, setHistoryError] = useState("");
  const [job, setJob] = useState(null);
  const [jobError, setJobError] = useState("");
  const [backfill, setBackfill] = useState(null);
  const [model, setModel] = useState(null);
  const [gaps, setGaps] = useState([]);
  const [moreGaps, setMoreGaps] = useState(false);
  const [evidenceError, setEvidenceError] = useState("");
  const [workingGap, setWorkingGap] = useState(false);
  const [evidenceRevision, setEvidenceRevision] = useState(0);
  const [importReport, setImportReport] = useState(null);
  const [issue, setIssue] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [jobRevision, setJobRevision] = useState(0);
  const lifecycle = useRef(null);
  const inFlight = useRef(false);
  const importing = source === "pgn";
  const refreshing = job?.status === "running";
  const report = importReport ?? job?.report;
  const refreshFailed = !importReport && job?.status === "failed";

  useEffect(() => {
    lifecycle.current = new AbortController();
    return () => lifecycle.current?.abort();
  }, []);

  useEffect(() => {
    let current = true;
    setCatalogError("");
    sendRepertoireCommand({ command: "list" }).then(reply => {
      if (reply.status === "error") throw new Error(reply.message);
      if (current) {
        setRepertoires(reply.repertoires);
        setDataset(reply.dataset_id);
      }
    }).catch(error => {
      if (current) setCatalogError(error.message || "Could not load repertoires.");
    });
    return () => { current = false; };
  }, [reload]);

  useEffect(() => {
    const request = new AbortController();
    setHistoryError("");
    readGameHistory(request.signal).then(next => {
      if (!request.signal.aborted) setHistory(next);
    }).catch(error => {
      if (!request.signal.aborted) setHistoryError(error.message || "Could not load game history.");
    });
    return () => request.abort();
  }, [reload, historyRevision]);

  useEffect(() => {
    const request = new AbortController();
    let timer;
    async function check() {
      try {
        const next = await readGameJob(request.signal);
        if (request.signal.aborted) return;
        setJobError("");
        setJob(next);
        if (next.status === "running") timer = setTimeout(check, 1000);
        else setHistoryRevision(revision => revision + 1);
      } catch (error) {
        if (!request.signal.aborted) setJobError(error.message || "Could not check the refresh.");
      }
    }
    void check();
    return () => {
      request.abort();
      clearTimeout(timer);
    };
  }, [jobRevision]);

  useEffect(() => {
    const request = new AbortController();
    let timer;
    let wasRunning = false;
    async function check() {
      try {
        const [historical, inference, coverage] = await Promise.all([
          historicalStatus(request.signal), modelStatus(request.signal), readGaps(request.signal),
        ]);
        if (request.signal.aborted) return;
        setBackfill(historical);
        setModel(inference);
        setGaps(coverage.gaps);
        setMoreGaps(coverage.more === true);
        const running = historical.status === "running" || inference.status === "running";
        if (wasRunning && !running) setHistoryRevision(value => value + 1);
        wasRunning = running;
        if (running) timer = setTimeout(check, 2000);
      } catch (error) {
        if (!request.signal.aborted) setEvidenceError(error.message);
      }
    }
    void check();
    return () => { request.abort(); clearTimeout(timer); };
  }, [evidenceRevision, historyRevision]);

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
    setEvidenceError("");
    try {
      setModel(await startModel({ dataset_id: dataset }, lifecycle.current.signal));
      setEvidenceRevision(value => value + 1);
    } catch (error) { setEvidenceError(error.message); }
  }

  async function openGap(gap) {
    setEvidenceError("");
    setWorkingGap(true);
    try {
      const address = {
        dataset_id: dataset, repertoire_id: gap.repertoire_id, position: gap.position,
        actual_move: gap.actual_move, document_revision: gap.document_revision,
      };
      const details = await gapDraft(address, lifecycle.current.signal);
      onGap({ address, details });
    } catch (error) {
      if (!lifecycle.current.signal.aborted) setEvidenceError(error.message);
    } finally { setWorkingGap(false); }
  }

  function remember(command) {
    setPending(command);
    try {
      if (command) sessionStorage.setItem(pendingKey, JSON.stringify(command));
      else sessionStorage.removeItem(pendingKey);
    } catch { /* Keep the command in memory when the browser limits storage. */ }
  }

  async function deliver(command, signal) {
    remember(command);
    if (command.kind === "backfill" || command.kind === "backfill-retry") {
      const submit = command.kind === "backfill" ? startHistorical : retryHistorical;
      const status = await submit(command.payload, signal);
      if (signal.aborted) return;
      setBackfill(status);
      setEvidenceRevision(value => value + 1);
      remember(null);
    } else if (command.kind !== "refresh") {
      const submitGame = { import: importGamePgn, choose: chooseGameCorrection, reprocess: reprocessGames }[command.kind];
      const result = await submitGame(command.payload, signal);
      if (signal.aborted) return;
      setImportReport(result);
      setHistoryRevision(revision => revision + 1);
      remember(null);
    } else {
      await refreshGames(command.payload, signal);
      if (signal.aborted) return;
      setJob({ status: "running" });
      setJobRevision(revision => revision + 1);
    }
  }

  useEffect(() => {
    if (pending?.kind === "refresh" && job?.status === "complete" &&
        job.commandId === pending.payload.command_id) remember(null);
  }, [job, pending]);

  async function run(build) {
    if (inFlight.current || !job || jobError) return;
    const signal = lifecycle.current.signal;
    inFlight.current = true;
    setBusy(true);
    setIssue("");
    setImportReport(null);
    try {
      const command = await build();
      if (!signal.aborted) await deliver(command, signal);
    } catch (error) {
      if (!signal.aborted) {
        setIssue(error.message || "Could not process these games.");
        setHistoryRevision(revision => revision + 1);
        setJobRevision(revision => revision + 1);
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
        if (file.size > maxGameCommandBytes) throw new Error("Choose a PGN file under 2 MiB.");
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
  return (
    <main className="tempo-core repertoire-page games-page">
      <PageHeader title="Games" actions={<Button onClick={onStudy}>Study</Button>} />
      <Surface>
        <h2>Compare completed games</h2>
        {catalogError && <StatusNotice kind="error">{catalogError}</StatusNotice>}
        {repertoires?.length === 0 && (
          <p>Save a repertoire before comparing games. <Button onClick={onRepertoires}>Repertoires</Button></p>
        )}
        <form className="repertoire-form" onSubmit={submit}>
          <fieldset disabled={busy || !!pending || refreshing || !dataset}>
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
        {pending && !busy && !refreshing && (
          <div className="actions">
            <Button disabled={!job || !!jobError} onClick={() => void run(() => pending)}>Retry same request</Button>
            <Button onClick={() => { remember(null); setIssue(""); }}>Dismiss pending request</Button>
          </div>
        )}
        {jobError && <StatusNotice kind="error">{jobError}</StatusNotice>}
        {refreshing && !jobError && <p role="status">Refreshing games. You can return to Study while this runs.</p>}
        {(catalogError || jobError) && (
          <Button onClick={() => {
            setJob(null);
            setJobRevision(value => value + 1);
            setReload(value => value + 1);
          }}>Reload Games</Button>
        )}
      </Surface>
      <HistoricalImport key={backfill?.job_id ?? "idle"} job={backfill}
        disabled={!dataset || busy || !!pending || refreshing} onStart={beginBackfill}
        onRetry={() => void run(() => ({ kind: "backfill-retry", payload: {
          command_id: crypto.randomUUID(), dataset_id: dataset, job_id: backfill.job_id,
        } }))} />
      <Surface>
        <h2>Opponent coverage gaps</h2>
        <div className="actions">
          <Button disabled={!dataset || model?.status === "running"} onClick={() => void analyze()}>
            Analyze Maia probabilities
          </Button>
        </div>
        {model && model.status !== "idle" && (
          <p role="status">{model.profile} · {model.status} · {model.completed} of {model.total} positions
            {model.error && ` · ${model.error}`}</p>
        )}
        {evidenceError && <StatusNotice kind="error">{evidenceError}</StatusNotice>}
        {moreGaps && <p>Showing the 100 most frequent gaps.</p>}
        {gaps.length === 0 ? <p>No confirmed opponent gaps in the current documents.</p> : (
          <ul className="game-results">{gaps.map(gap => (
            <li key={`${gap.repertoire_id}:${gap.position}:${gap.actual_move}`}>
              <strong>{repertoires?.find(book => book.id === gap.repertoire_id)?.name ?? gap.repertoire_id}</strong>
              <p>{gap.actual_move} · {gap.games} {gap.games === 1 ? "game" : "games"}</p>
              <Button disabled={workingGap || !dataset} onClick={() => void openGap(gap)}>Open response editor</Button>
            </li>
          ))}</ul>
        )}
      </Surface>
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
            <Button onClick={() => setHistoryRevision(revision => revision + 1)}>Reload game evidence</Button>
          </>
        )}
        {history ? history.results.length > 0
          ? <GameResults history onChoose={pending || busy || refreshing ? undefined : choose} results={history.results} repertoires={repertoires ?? []} />
          : <p>No games recorded yet.</p>
          : !historyError && <p role="status">Loading game evidence…</p>}
      </Surface>
    </main>
  );
}

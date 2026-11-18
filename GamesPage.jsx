import React, { useEffect, useRef, useState } from "react";
import { Button, PageHeader, StatusNotice, Surface } from "@tempo-v2/core-components";
import {
  gameEffects, importGamePgn, maxGameCommandBytes, readGameHistory, readGameJob, refreshGames,
  sourceNames, utcDateRange, utcDayMs,
} from "./game_commands.js";
import { sendRepertoireCommand } from "./repertoire_commands.js";

function GameResults({ results, repertoires }) {
  return (
    <ul className="game-results">
      {results.map(result => {
        const repertoire = repertoires.find(item => item.id === result.repertoire_id);
        const source = Object.hasOwn(sourceNames, result.source) ? sourceNames[result.source] : "Game";
        const gameLink = `${source} game`;
        return (
          <li key={JSON.stringify([result.source, result.game_id, result.repertoire_id, result.learner])}>
            <div>
              {result.url
                ? <a href={result.url} target="_blank" rel="noopener noreferrer">{gameLink}</a>
                : <strong>{gameLink}</strong>}
              <span> · {result.learner} · {repertoire?.name ?? result.repertoire_id}</span>
              {result.occurrence_end_ms !== null && (
                <span> · {new Date(result.occurrence_end_ms).toLocaleDateString()}</span>
              )}
            </div>
            <p className="game-result-effect">{gameEffects[result.effect]}</p>
            {result.first_deviation_ply !== null && (
              <p><strong>First learner deviation on half-move {result.first_deviation_ply}</strong></p>
            )}
            <p>{result.matches} matched · {result.deviations} learner deviations · {result.opponent_deviations} opponent deviations · {result.coverage_gaps} outside coverage</p>
          </li>
        );
      })}
    </ul>
  );
}

function GameReport({ report, importing, repertoires }) {
  return (
    <>
      <dl className="content-preview">
        <dt>{importing ? "Games read" : "Games fetched"}</dt><dd>{report.fetched}</dd>
        <dt>New games</dt><dd>{report.new_games}</dd>
        <dt>Duplicates</dt><dd>{report.duplicates}</dd>
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

export function GamesPage({ onStudy, onRepertoires }) {
  const [source, setSource] = useState("lichess");
  const [repertoires, setRepertoires] = useState(null);
  const [catalogError, setCatalogError] = useState("");
  const [history, setHistory] = useState(null);
  const [historyError, setHistoryError] = useState("");
  const [job, setJob] = useState(null);
  const [jobError, setJobError] = useState("");
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
      if (current) setRepertoires(reply.repertoires);
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

  async function submit(event) {
    event.preventDefault();
    if (inFlight.current || !job || refreshing || jobError) return;
    const form = new FormData(event.currentTarget);
    const signal = lifecycle.current.signal;
    inFlight.current = true;
    setBusy(true);
    setIssue("");
    setImportReport(null);
    try {
      const repertoire_id = form.get("repertoire");
      if (!repertoires?.some(item => item.id === repertoire_id))
        throw new Error("Choose the repertoire to compare against.");
      const learner = form.get("learner").trim();
      if (!learner) throw new Error("Enter the learner’s account name.");
      if (importing) {
        const file = form.get("file");
        if (file.size > maxGameCommandBytes) throw new Error("Choose a PGN file under 2 MiB.");
        const pgn = file.size ? await file.text() : form.get("pgn");
        if (!pgn.trim()) throw new Error("Choose a PGN file or paste a completed game.");
        if (file.size && form.get("pgn").trim())
          throw new Error("Choose either a PGN file or pasted PGN.");
        if (signal.aborted) return;
        const result = await importGamePgn({ learner, repertoire_id, pgn }, signal);
        if (signal.aborted) return;
        setImportReport(result);
        setHistoryRevision(revision => revision + 1);
      } else {
        const range = utcDateRange(form.get("from"), form.get("to"));
        await refreshGames({ source, account: learner, repertoire_id, ...range }, signal);
        if (signal.aborted) return;
        setJob({ status: "running" });
        setJobRevision(value => value + 1);
      }
    } catch (error) {
      if (!signal.aborted) {
        setIssue(error.message || "Could not process these games.");
        if (importing) setHistoryRevision(revision => revision + 1);
        else {
          setJob(null);
          setJobRevision(value => value + 1);
        }
      }
    } finally {
      inFlight.current = false;
      if (!signal.aborted) setBusy(false);
    }
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
          <fieldset disabled={busy || refreshing || !repertoires?.length}>
            <div className="repertoire-fields">
              <label>Source <select value={source} onChange={event => setSource(event.target.value)}>
                {Object.entries(sourceNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select></label>
              <label>{importing ? "Learner name in PGN" : "Account name"}
                <input key={source} name="learner" required autoComplete="off" maxLength={128} />
              </label>
              <label>Repertoire
                <select name="repertoire" defaultValue="" required>
                  <option value="" disabled>Choose repertoire</option>
                  {repertoires?.map(item => (
                    <option value={item.id} key={item.id}>{item.name} · {item.learner_color}</option>
                  ))}
                </select>
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
                {importing ? "Import games" : "Refresh games"}
              </Button>
            </div>
          </fieldset>
        </form>
        {issue && <StatusNotice kind="error">{issue}</StatusNotice>}
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
          ? <GameResults results={history.results} repertoires={repertoires ?? []} />
          : <p>No games recorded yet.</p>
          : !historyError && <p role="status">Loading game evidence…</p>}
      </Surface>
    </main>
  );
}

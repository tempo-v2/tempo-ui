import { pushDesktopEntry, replaceDesktopEntry, subscribeGamesHistory } from "./desktop_history.js";
import { hasReviewDraft } from "./review_draft.js";
import { GameLibrary, recordedFinding } from "./GameLibrary.jsx";
import { GameWorkbench, readReviewMark } from "./GameWorkbench.jsx";
import { gamesTabs, readVisit, requestedGamesTab, reviewAddress, reviewUrl, sameGame } from "./review_route.js";
import { AnalysisPage } from "./AnalysisPage.jsx";
import React, { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, IconButton, PageHeader, SectionHeader, StatusNotice, Surface } from "@tempo-v2/core-components";
import { NextIcon, PreviousIcon } from "./ControlIcons.jsx";
import {
  recoverGameChoice, gameEffects, importGamePgn, recoverReprocessGames, readGameHistory, recoverGameRefresh,
  sourceNames, gapDraft, readGaps, recoverHistorical,
} from "./game_commands.js";
import { ApplicationContext } from "./application_context.js";
import { readRepertoireCatalog } from "./repertoire_commands.js";
import { RepertoireCoverage, coveragePercent } from "./RepertoireCoverage.jsx";
import { GapEditor } from "./GapEditor.jsx";
import { gapAddress, gapKey, readGapContinuation } from "./gap_save.js";
import { commandRecovery } from "./content_transport.js";
import { DiagnosticsButton } from "./DiagnosticsButton.jsx";

// History is newest-comparison first. Group only the history window; a command report
// keeps its original per-result rows and command outcomes.
function groupGames(results, history) {
  if (!history) return results.map((result, index) => ({key:index, rows:[result]}));
  const rowsByGame = new Map();
  for (const result of results) {
    const key = JSON.stringify([result.source, result.game_id, result.learner]);
    if (!rowsByGame.has(key)) rowsByGame.set(key, []);
    rowsByGame.get(key).push(result);
  }
  return [...rowsByGame].map(([key, rows]) => ({key, rows}));
}

function GameResults({ groups, results, repertoires, history = false, dataset, onOpen }) {
  return (
    <ul className="game-results">
      {(groups ?? groupGames(results, history)).map(({rows, key, game, comparisons}) => {
        const result = rows[0] ?? game;
        const source = Object.hasOwn(sourceNames, result.source) ? sourceNames[result.source] : "Game";
        const gameLink = source + " game";
        const review = { dataset_id: dataset, source: result.source, game_id: result.game_id,
          learner: result.learner, repertoire_id: null };
        const openGame = (address) => onOpen(address, game?.repertoires ?? result.repertoires ?? []);
        const visit = dataset && readVisit(review);
        const mark = dataset && readReviewMark(visit?.address ?? review);
        const date = game?.played_ms ?? result.players?.played_date_ms ?? result.occurrence_end_ms;
        const gameTitle = game ? game.white + " vs " + game.black : result.players ? result.players.white + " vs " + result.players.black : gameLink + " · " + result.learner;
        return (
          <li key={key}>
            {onOpen && <div className="game-row"><div><Button variant="quiet" size="compact" className="game-title" onClick={() => openGame(review)}>{gameTitle}</Button>
              <p>{source} · {game?.color ? "Played "+game.color : result.learner}{date != null && " · " + new Date(date).toLocaleDateString(undefined, {timeZone:"UTC"})}
                </p>
              {game && <><p className="game-opening-name">{[game.eco,game.opening].filter(Boolean).join(" · ") || "Opening moves"}</p>
                <p className="game-opening-moves">{game.moves.join(" ")}</p></>}
              {game && comparisons.length === 1 && comparisons.map(book => <p key={book.repertoire_id}>
                At import · {repertoires.find(b=>b.id === book.repertoire_id)?.name ?? "Recorded repertoire"} · {recordedFinding(book, game.moves)}
              </p>)}
              {game && !game.repertoires.length && <p>No per-repertoire comparison was recorded.</p>}
              {visit?.comparison && <p><strong>Last compared with {repertoires.find(b => b.id === visit.comparison.repertoire_id)?.name ?? visit.comparison.name}</strong>
                {" · "}{visit.comparison.text}</p>}
              {mark && <p>{mark.document_id === visit?.comparison?.document_id ? "You marked this comparison reviewed." : "You marked an earlier comparison reviewed."}</p>}
              {visit?.saved && <p>Saved through {visit.saved.endpoint} to {repertoires.find(b => b.id === visit.saved.repertoire_id)?.name ?? visit.saved.name}</p>}
              {dataset && hasReviewDraft(review) && <p>Unsaved continuation in this browser</p>}
              {visit && <Button variant="quiet" size="compact" className="inline-link" onClick={() => openGame(visit.address)}>Resume last position</Button>}</div>
              <Button onClick={() => openGame(review)}>Review game</Button></div>}
            <details className="record-details"><summary>{rows.length ? "Import-time comparison"+(rows.length > 1 ? "s · "+rows.length : "") : "Tactics tools"}</summary>
              {rows.map((result, i) => {
                const repertoire = repertoires.find(item => item.id === result.repertoire_id);
                return <div key={result.comparison_id || i} className="comparison-record">
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
            <p>{result.matches} matched · {result.deviations} learner misses · {result.opponent_deviations} opponent deviations · {result.coverage_gaps} outside coverage</p>
            </div>; })}
            </details>
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

function GameReport({ report, importing, repertoires, dataset, onOpen, history }) {
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
      <GameResults results={report.results.map(row => {
        const match = history?.results.find(candidate => sameGame(candidate,row));
        return match ? { ...row, players: match.players } : row;
      })} repertoires={repertoires} dataset={dataset} onOpen={onOpen} />
    </>
  );
}

const gameRecovery = commandRecovery("tempo.games.pending.v1");
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

function evidenceFor(resource, dataset, offset) {
  return resource?.dataset === dataset && resource.offset === offset ? resource : undefined;
}

function historyTab() {
  const tab = requestedGamesTab() ?? window.history.state?.gamesTab;
  return gamesTabs.some(([id]) => id === tab) ? tab : "library";
}

function GamesPanel({ id, tab, children }) {
  return <section className="games-tabpanel" id={`games-panel-${id}`} role="tabpanel"
    aria-labelledby={`games-tab-${id}`} hidden={id !== tab} tabIndex={0}>
    {children}
  </section>;
}

export function GamesPage({ onStudy }) {
  const { datasetId: dataset, issue: contextIssue, refresh: refreshContext } = useContext(ApplicationContext);
  const [review, setReview] = useState(reviewAddress);
  const [analysis, setAnalysis] = useState(null);
  const [recovery] = useState(readGapContinuation);
  const [tab, setTab] = useState(() => recovery ? "coverage" : historyTab());
  const [focusRequest, setFocusRequest] = useState(null);
  const [focusedTab, setFocusedTab] = useState(null);
  const learnerInput = useRef(null);
  const tabButtons = useRef({});
  const gapOpening = useRef(null);

  useLayoutEffect(() => {
    if (!focusRequest) return;
    const input = learnerInput.current;
    if (focusRequest.learner && input && !input.matches(":disabled")) input.focus();
    else tabButtons.current[focusRequest.tab]?.focus({ preventScroll: true });
  }, [focusRequest]);

  useEffect(() => {
    if (recovery) {
      replaceDesktopEntry({ gamesTab: "coverage" }, "#games");
      setReview(null);
    }
  }, [recovery]);

  useEffect(() => {
    function sync() {
      const selected = historyTab();
      if (requestedGamesTab()) {
        replaceDesktopEntry({ gamesTab: selected }, "#games");
        window.scrollTo?.(0, 0);
      }
      if (analysis) {
        setAnalysis(null);
        setActiveGap(null);
        refreshEvidenceReads();
      }
      const next = reviewAddress();
      if (next || selected !== "coverage") cancelGapOpening();
      setReview(next);
      setTab(selected);
    }
    if (requestedGamesTab()) sync();
    return subscribeGamesHistory(sync);
  }, [analysis]);

  function cancelGapOpening() {
    if (gapOpening.current) {
      gapOpening.current.abort();
      gapOpening.current = null;
      setWorkingGap(false);
    }
  }

  function selectTab(next, { learner = false } = {}) {
    if (next !== "coverage") cancelGapOpening();
    replaceDesktopEntry({ ...window.history.state, gamesTab: next }, "#games");
    setTab(next);
    if (next !== tab || learner) window.scrollTo?.(0, 0);
    setFocusRequest({ tab: next, learner });
  }

  function moveTabFocus(event, index) {
    const last = gamesTabs.length - 1;
    const target = {
      ArrowLeft: index === 0 ? last : index - 1,
      ArrowRight: index === last ? 0 : index + 1,
      Home: 0,
      End: last,
    }[event.key];
    if (typeof target !== "number") return;
    event.preventDefault();
    tabButtons.current[gamesTabs[target][0]]?.focus();
  }

  function openReview(next, recordedComparisons) {
    const previous = window.history.state?.reviewLibrary;
    const comparisons = recordedComparisons ?? (previous?.dataset_id === next.dataset_id && sameGame(previous,next) ? previous.comparisons : []);
    const reviewLibrary = {dataset_id:next.dataset_id, source:next.source, game_id:next.game_id, learner:next.learner, comparisons};
    pushDesktopEntry({ reviewLibrary, gamesTab: tab }, reviewUrl(next));
    setReview(next);
    window.scrollTo?.(0, 0);
  }

  function closeReview() {
    const selected = historyTab();
    pushDesktopEntry({ gamesTab: selected }, "#games");
    setReview(null);
    selectTab(selected);
    refreshHistory(); refreshEvidenceReads();
  }
  const [catalog, setCatalog] = useState(null);
  const repertoires = catalog?.dataset_id === dataset ? catalog.repertoires : null;
  const [pendingEntry, setPendingEntry] = useState(null);
  const [recoveryStatus, setRecoveryStatus] = useState("loading");
  const [cleanupIssue, setCleanupIssue] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const [history, setHistory] = useState(null);
  const [historyError, setHistoryError] = useState("");
  const [evidence, setEvidence] = useState({});
  const [gapActionError, setGapActionError] = useState("");
  const [workingGap, setWorkingGap] = useState(false);
  const [forecastBook, setForecastBook] = useState(() => recovery?.gap.forecastBook ?? null);
  const [gapOffset, setGapOffset] = useState(() => recovery?.gap.offset ?? 0);
  const [activeGap, setActiveGap] = useState(() => recovery?.gap ?? null);
  const [gapNotice, setGapNotice] = useState("");
  const [evidenceRevision, setEvidenceRevision] = useState(0);
  const [importResult, setImportResult] = useState(null);
  const [refreshResult, setRefreshResult] = useState(null);
  const [historicalResult, setHistoricalResult] = useState(null);
  const [issue, setIssue] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [historyRevision, setHistoryRevision] = useState(0);
  const lifecycle = useRef(null);
  const evidenceOwner = useRef(null);
  const historyOwner = useRef(null);
  const activeDataset = useRef(null);
  const previouslyIdentifiedDataset = useRef(null);
  const inFlight = useRef(false);
  const comparing = !!review?.repertoire_id;
  const needsCatalog = (comparing && !activeGap) ||
    (!review && !analysis && tab === "coverage");
  const pending = pendingEntry?.command;
  const settledCleanup = ["accepted", "retired"].includes(pendingEntry?.phase);
  const commandsBlocked = recoveryStatus !== "ready" || !!pending;
  const canRetryPending = pending && !settledCleanup && !busy;
  const recoverSavedImportWithoutContext = !dataset && !!contextIssue &&
    pendingEntry?.phase === "saved" && pending?.kind === "import" &&
    (previouslyIdentifiedDataset.current === null ||
      previouslyIdentifiedDataset.current === pending.payload.dataset_id);
  const needsRecovery = canRetryPending || (!busy && (settledCleanup || recoveryStatus === "blocked"));
  const currentReport = importResult?.datasetId === dataset ? importResult : null;
  const choiceReport = currentReport?.kind === "choose" ? currentReport.report : null;
  const importReport = currentReport?.kind !== "choose" ? currentReport?.report : null;
  const importReportTitle = currentReport?.kind === "reprocess" ? "Recovered reprocess results" : "Import results";
  const confirmedRefresh = refreshResult?.datasetId === dataset ? refreshResult : null;
  const gapRead = evidence.forecastBook === forecastBook
    ? evidenceFor(evidence, dataset, gapOffset) : undefined;
  const gapPage = gapRead?.value;

  function updateGapEvidence(changes, offset) {
    setEvidence(current => ({
      ...evidenceFor(current.forecastBook === forecastBook ? current : undefined, dataset, offset),
      dataset, offset, forecastBook, ...changes,
    }));
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

  useLayoutEffect(() => {
    activeDataset.current = dataset;
    if (!dataset) return;
    if (previouslyIdentifiedDataset.current !== null && previouslyIdentifiedDataset.current !== dataset) {
      evidenceOwner.current?.abort();
      historyOwner.current?.abort();
      setHistory(null);
      setHistoryError("");
      refreshHistory();
    }
    previouslyIdentifiedDataset.current = dataset;
  }, [dataset]);

  useEffect(() => {
    if (!needsCatalog || !dataset) return;
    const owner = new AbortController();
    setCatalogError("");
    readRepertoireCatalog(owner.signal).then(reply => {
      if (!owner.signal.aborted && reply.dataset_id === dataset) setCatalog(reply);
      else if (!owner.signal.aborted) setCatalogError("The current data changed. Reload Games.");
    }).catch(error => {
      if (!owner.signal.aborted) setCatalogError(error.message || "Could not load repertoires.");
    });
    return () => owner.abort();
  }, [dataset, needsCatalog, reload]);

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
    const owner = new AbortController();
    evidenceOwner.current = owner;
    readGaps(owner.signal, gapOffset, forecastBook).then(value => {
      if (owner.signal.aborted) return;
      if (value.dataset_id !== dataset) throw new Error("Opponent gaps belong to a different dataset.");
      updateGapEvidence({ value, error: "" }, gapOffset);
    }).catch(error => {
      if (!owner.signal.aborted) updateGapEvidence({ error: error.message || "Could not load opponent gaps." }, gapOffset);
    });
    return () => owner.abort();
  }, [dataset, evidenceRevision, gapOffset, forecastBook]);

  async function loadGap(gap, offset, signal, datasetId = dataset) {
    const address = gapAddress(datasetId, gap);
    const details = await gapDraft(address, AbortSignal.any([signal, AbortSignal.timeout(gapDraftTimeoutMs)]));
    if (!signal.aborted) setActiveGap({ address, details, offset, forecastBook, forecast: gap.forecast });
  }

  async function openGap(gap) {
    const owner = new AbortController();
    gapOpening.current = owner;
    const signal = AbortSignal.any([lifecycle.current.signal, owner.signal]);
    setGapActionError("");
    setGapNotice("");
    setWorkingGap(true);
    try {
      await loadGap(gap, gapOffset, signal);
    } catch (error) {
      if (!signal.aborted) {
        setGapActionError(error.message);
        refreshEvidenceReads();
      }
    } finally {
      if (gapOpening.current === owner) {
        gapOpening.current = null;
        if (!signal.aborted) setWorkingGap(false);
      }
    }
  }

  async function advanceGap(label) {
    const signal = lifecycle.current.signal;
    const { address, forecastBook: scope } = activeGap;
    const page = await readGaps(signal, 0, scope);
    if (page.dataset_id !== address.dataset_id) throw new Error("The active dataset changed.");
    if (signal.aborted) return;
    const next = page.gaps.find(gap => gapKey(gap) !== gapKey(address));
    refreshEvidenceReads();
    updateGapEvidence({ value: page, error: "" }, 0);
    setGapOffset(0);
    if (next) await loadGap(next, 0, signal, address.dataset_id);
    else setActiveGap(null);
    if (!signal.aborted) setGapNotice(`Saved ${label}.`);
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
    return !signal.aborted && command.payload.dataset_id === activeDataset.current;
  }

  async function settle(command, reply) {
    if (command.kind === "refresh") setRefreshResult(reply);
    setPendingEntry({ command, phase: "accepted" });
    setIssue("");
    await clearPending({ accepted: true });
  }

  async function deliver(command, signal, recoveryWithoutContext) {
    if (command.kind === "backfill" || command.kind === "backfill-retry") {
      const reply = await recoverHistorical(command.payload, command.kind === "backfill-retry", signal);
      if (!owns(command, signal)) return;
      if (reply.status === "retired") {
        setPendingEntry({ command, phase: "retired" });
        await clearPending();
        setIssue(reply.message);
      } else {
        setHistoricalResult(reply);
        await settle(command);
      }
    } else if (command.kind !== "refresh") {
      let result;
      if (command.kind === "reprocess" || command.kind === "choose") {
        const recover = command.kind === "choose" ? recoverGameChoice : recoverReprocessGames;
        const reply = await recover(command.payload, signal);
        if (!owns(command, signal)) return;
        if (reply.status === "retired") {
          setPendingEntry({ command, phase: "retired" });
          await clearPending();
          setIssue(reply.message);
          return;
        }
        result = reply.report;
      } else {
        result = await importGamePgn(command.payload, signal);
      }
      if (signal.aborted || (!recoveryWithoutContext && !owns(command, signal))) return;
      setImportResult({ datasetId: command.payload.dataset_id, kind: command.kind, report: result });
      if (owns(command, signal)) {
        refreshHistory();
        refreshEvidenceReads();
      }
      await settle(command);
    } else {
      const reply = await recoverGameRefresh(command.payload, signal);
      if (!owns(command, signal)) return;
      if (reply.status === "retired") {
        setPendingEntry({ command, phase: "retired" });
        await clearPending();
        setIssue(reply.message);
      } else {
        refreshHistory();
        refreshEvidenceReads();
        await settle(command, reply);
      }
    }
  }

  async function run(build, { recovering = false } = {}) {
    if (recoveryStatus !== "ready" || inFlight.current) return;
    const recoveryWithoutContext = recovering && recoverSavedImportWithoutContext;
    if (recovering) {
      if (!pending || settledCleanup ||
          (!recoveryWithoutContext && (!dataset || pending.payload.dataset_id !== dataset))) return;
    } else if (!dataset || pending) return;
    const signal = lifecycle.current.signal;
    inFlight.current = true;
    setBusy(true);
    setIssue("");
    setCleanupIssue("");
    setImportResult(null);
    const canDeliver = command => owns(command, signal) ||
      (recoveryWithoutContext && !signal.aborted && activeDataset.current === null && command === pending &&
        (previouslyIdentifiedDataset.current === null ||
          previouslyIdentifiedDataset.current === command.payload.dataset_id));
    let command;
    try {
      command = await build();
      if (!canDeliver(command)) return;
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
      if (canDeliver(command)) await deliver(command, signal, recoveryWithoutContext);
    } catch (error) {
      if (!signal.aborted && (recoveryWithoutContext || dataset === activeDataset.current)) {
        setIssue(error.message || "Could not process these games.");
        if (command && owns(command, signal)) {
          refreshHistory();
          refreshEvidenceReads();
        }
      }
    } finally {
      inFlight.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }

  function submit(event) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    void run(async () => {
      if (!dataset) throw new Error("Tempo could not identify the dataset.");
      const learner = form.get("learner").trim();
      if (!learner) throw new Error("Enter the learner’s account name.");
      const identity = { command_id: crypto.randomUUID(), dataset_id: dataset };
      const file = form.get("file");
      const pgn = file.size ? await file.text() : form.get("pgn");
      if (!pgn.trim()) throw new Error("Choose a PGN file or paste a completed game.");
      if (file.size && form.get("pgn").trim())
        throw new Error("Choose either a PGN file or pasted PGN.");
      return { kind: "import", payload: { ...identity, learner, pgn } };
    });
  }

  function returnFromAnalysis(saved) {
    setAnalysis(null);
    if (saved) {
      setActiveGap(null);
      refreshEvidenceReads();
    }
  }
  const libraryOrigin = window.history.state?.reviewLibrary;
  const recordedComparisons = review && libraryOrigin?.dataset_id === review.dataset_id && sameGame(libraryOrigin, review) ? libraryOrigin.comparisons : [];
  const reviewing = review && !activeGap;
  const panelsHidden = !!(reviewing || analysis);
  return <div className="tempo-core">
    {reviewing && !dataset ? <main className="tempo-core review-page">
      <Button onClick={closeReview}>← Games</Button>
      {contextIssue
        ? <StatusNotice kind="error">{contextIssue} <Button onClick={refreshContext}>Retry connection</Button></StatusNotice>
        : <p role="status">Loading Games…</p>}
    </main> : reviewing && comparing && dataset && repertoires === null ? <main className="tempo-core review-page">
      <Button onClick={closeReview}>← Games</Button>
      {catalogError
        ? <StatusNotice kind="error">{catalogError} <Button onClick={() => setReload(value => value + 1)}>Retry comparison</Button></StatusNotice>
        : <p role="status">Loading repertoires…</p>}
    </main> : reviewing && <GameWorkbench recordedComparisons={recordedComparisons} address={review} dataset={dataset} books={comparing ? repertoires ?? [] : []}
      onClose={closeReview} changeBook={(id, cursor) => openReview({...review, repertoire_id:id, ...cursor})}
      onSaved={() => {refreshHistory(); refreshEvidenceReads();}} />}
    {analysis && <AnalysisPage origin={analysis} onClose={returnFromAnalysis} />}
    <main className="tempo-core repertoire-page games-page" hidden={panelsHidden}>
      <Button size="compact" variant="quiet" onClick={onStudy}>← Study</Button>
      <PageHeader title="Games"
        actions={<><DiagnosticsButton /><Button onClick={() => selectTab("import", { learner: true })}>Import PGN</Button></>} />
      {contextIssue && <StatusNotice kind="error">{contextIssue}</StatusNotice>}
      <div className="games-tabs" role="tablist" aria-label="Games views" onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusedTab(null);
      }}>
        {gamesTabs.map(([id, label], index) => (
          <button key={id} id={`games-tab-${id}`} ref={node => { tabButtons.current[id] = node; }}
            type="button" role="tab" aria-selected={tab === id} aria-controls={`games-panel-${id}`}
            tabIndex={(focusedTab ?? tab) === id ? 0 : -1} onFocus={() => setFocusedTab(id)} onClick={() => selectTab(id)}
            onKeyDown={event => moveTabFocus(event, index)}>{label}</button>
        ))}
      </div>
      {tab !== "import" && needsRecovery && (
        <div role="status"><Button size="compact" variant="quiet" onClick={() => {
          selectTab("import");
        }}>Review Games request</Button></div>
      )}
      <GamesPanel id="import" tab={tab}>
        <Surface>
          <h2>Import a PGN</h2>
          <form className="repertoire-form" onSubmit={submit}>
            <fieldset disabled={busy || commandsBlocked || !dataset}>
              <div className="repertoire-fields">
                <label>Learner name
                  <input ref={learnerInput} name="learner" required autoComplete="off" maxLength={128} />
                </label>
              </div>
              <label>PGN file <input type="file" name="file" accept=".pgn,.txt,application/x-chess-pgn,text/plain" /></label>
              <label>Or paste PGN <textarea name="pgn" rows={5} /></label>
              <div className="actions">
                <Button type="submit" pending={busy} disabled={busy}>Import games</Button>
              </div>
            </fieldset>
          </form>
          {issue && <StatusNotice kind="error">{issue}</StatusNotice>}
          {!dataset && importResult?.kind === "import" && <StatusNotice>Games import confirmed.</StatusNotice>}
          {cleanupIssue && <StatusNotice kind="error">{cleanupIssue}</StatusNotice>}
          {recoveryStatus === "blocked" && (
            <div className="actions">
              <StatusNotice kind="error">Tempo could not read the pending Games request.</StatusNotice>
              <Button disabled={busy} onClick={() => setRecoveryStatus("loading")}>Retry recovery</Button>
              <Button disabled={busy} onClick={() => void cleanup()}>Dismiss pending request</Button>
            </div>
          )}
          {settledCleanup && !busy && (
            <Button onClick={() => void cleanup({ accepted: pendingEntry.phase === "accepted" })}>Retry cleanup</Button>
          )}
          {canRetryPending && (
            <div className="actions">
              {dataset && pending.payload.dataset_id !== dataset && (
                <StatusNotice kind="error">The pending Games request belongs to a different dataset.</StatusNotice>
              )}
              <Button disabled={!recoverSavedImportWithoutContext && (!dataset || pending.payload.dataset_id !== dataset)}
                onClick={() => void run(() => pending, { recovering: true })}>Retry same request</Button>
              <Button onClick={() => void cleanup({ unsaved: pendingEntry.phase === "unsaved" })}>Dismiss pending request</Button>
            </div>
          )}
          {contextIssue && (
            <Button onClick={() => {
              refreshContext();
              historyOwner.current?.abort();
              setReload(value => value + 1);
            }}>Reload Games</Button>
          )}
        </Surface>
        {confirmedRefresh && (
          <Surface>
            <h2>Recovered refresh results</h2>
            <GameReport report={confirmedRefresh.report} importing={false} dataset={dataset} onOpen={openReview} history={history} repertoires={repertoires ?? []} />
          </Surface>
        )}
        {importReport && (
          <details className="game-import" open><summary>{importReportTitle}</summary><Surface>
            <h2>{importReportTitle}</h2>
            <GameReport report={importReport} importing={currentReport.kind === "import"} dataset={dataset} onOpen={openReview}
              history={history} repertoires={repertoires ?? []} />
          </Surface></details>
        )}
        {dataset && historicalResult?.datasetId === dataset && (
          <StatusNotice kind="info">
            Historical Games request was accepted and is archived.
            {historicalResult.pendingWindows > 0 && ` Stopped windows: ${historicalResult.pendingWindows}.`}
            {historicalResult.incompleteWindows > 0 && ` Incomplete windows: ${historicalResult.incompleteWindows}.`}
          </StatusNotice>
        )}
      </GamesPanel>
      <GamesPanel id="library" tab={tab}>
        <Surface>
          <SectionHeader title="Game library" />
          {contextIssue && <Button size="compact" onClick={refreshContext}>Retry connection</Button>}
          {choiceReport && <details open>
            <summary>Corrective choice results</summary>
            <GameReport report={choiceReport} importing dataset={dataset} onOpen={openReview} history={history} repertoires={repertoires ?? []} />
          </details>}
          {!history && !historyError && <p role="status">Loading game evidence…</p>}
          {historyError && (
            <>
              <StatusNotice kind="error">{historyError}</StatusNotice>
              <Button onClick={refreshHistory}>Reload game evidence</Button>
            </>
          )}
          {!dataset && history && (history.results.length > 0
            ? <GameResults results={history.results} history repertoires={repertoires ?? []} />
            : <p>No games recorded yet.</p>)}
          {dataset && <GameLibrary key={dataset} dataset={dataset} refresh={historyRevision} recent={history?.results}
            renderRecent={results=><GameResults history results={results} dataset={dataset} onOpen={openReview}
              repertoires={repertoires ?? []} />}
            renderResults={groups=><GameResults groups={groups} dataset={dataset} history onOpen={openReview}
              repertoires={repertoires ?? []} />}
            empty={<div className="empty-games"><h3>No games recorded yet.</h3><p>Import a completed PGN to replay its moves. You can add a repertoire whenever you’re ready to compare your opening.</p></div>} />}
        </Surface>
      </GamesPanel>
      <GamesPanel id="coverage" tab={tab}>
        <Surface>
          <h2>Opponent coverage gaps</h2>
          <RepertoireCoverage key={dataset} dataset={dataset} repertoires={repertoires ?? []}
            forecastBook={forecastBook} onFilter={book => { setForecastBook(book); setGapOffset(0); }}
            onStartingLineSaved={refreshEvidenceReads} />
          {gapNotice && !activeGap && <StatusNotice>{gapNotice}</StatusNotice>}
          {gapActionError && <StatusNotice kind="error">{gapActionError}</StatusNotice>}
          {gapRead?.error && <>
            <StatusNotice kind="error">Opponent gaps · {gapRead.error}</StatusNotice>
            <Button onClick={refreshEvidenceReads}>Retry evidence reads</Button>
          </>}
          {(gapPage?.more || gapOffset > 0) && <nav className="actions compact-controls" aria-label="Coverage pages">
            <IconButton label="Previous gaps" disabled={gapOffset === 0 || workingGap}
              onClick={() => setGapOffset(offset => offset - 100)}><PreviousIcon /></IconButton>
            <IconButton label="Next gaps" disabled={!gapPage?.more || workingGap}
              onClick={() => setGapOffset(offset => offset + 100)}><NextIcon /></IconButton>
          </nav>}
          {!gapPage && !gapRead?.error && <p role="status">Loading opponent gaps…</p>}
          {gapPage?.gaps.length === 0 && <p>{forecastBook ? "No open suggestions from this scan." : "No confirmed opponent gaps in the current documents."}</p>}
          {gapPage?.gaps.length > 0 && (
            <ul className="game-results">{gapPage.gaps.map(gap => (
              <li key={gapKey(gap)}>
                <strong>{repertoires?.find(book => book.id === gap.repertoire_id)?.name ?? gap.repertoire_id}</strong>
                <p>{gap.actual_san ?? "Opponent move"}
                  {gap.games > 0 && ` · ${gap.games} ${gap.games === 1 ? "game" : "games"}`}
                  {gap.forecast && ` · ${coveragePercent(gap.forecast.probability)} estimated first-gap chance${gap.forecast.stale ? " (earlier scan)" : ""}`}
                </p>
                <Button disabled={workingGap || !dataset} onClick={() => void openGap(gap)}>Fix response</Button>
              </li>
            ))}</ul>
          )}
        </Surface>
      </GamesPanel>
    </main>
      {activeGap && (
        <GapEditor key={gapKey(activeGap.address)} gap={activeGap} suspended={!!analysis} onAnalyze={setAnalysis}
          recovery={activeGap === recovery?.gap ? recovery : null} onAdvance={advanceGap} previousSave={gapNotice}
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

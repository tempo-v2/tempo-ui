import React, { useEffect, useMemo, useRef, useState } from "react";
import { Board, Button } from "@tempo-v2/core-components";
import { Chess } from "chess.js";
import { readGameReview } from "./game_commands.js";
import { hasPendingRepertoireCommand, savePendingRepertoireCommand, sendRepertoireCommand } from "./repertoire_commands.js";
import { playBoardMove } from "./board_move.js";
import { PromotionChooser } from "./PromotionChooser.jsx";
import { usePositionEvidence } from "./position_evidence.js";
import { rememberVisit, reviewAddress, reviewUrl } from "./review_route.js";

const states = {
  position: "In repertoire", endpoint: "End of saved line", outside: "Outside repertoire",
  unavailable: "Preparation unavailable",
};
const departures = {
  learner_move: "Played a different move", opponent_gap: "Opponent played an unprepared move",
  authored_endpoint: "Play continued past the saved line", outside_context: "Outside the authored opening",
};
const colorName = color => color === "w" ? "White" : "Black";
const san = (fen, move) => playBoardMove(new Chess(fen), move).san;
function notation(fen, move) {
  const fields = fen.split(" ");
  return fields[5] + (fields[1] === "w" ? ". " : "… ") + san(fen, move);
}
function lineText(fen, path) {
  const board = new Chess(fen);
  return path.map((move, i) => {
    const label = board.turn() === "w" ? board.moveNumber() + "." : i === 0 ? board.moveNumber() + "…" : "";
    return label + playBoardMove(board, move).san;
  }).join(" ");
}
function decisionPly(comparison) {
  const dep = comparison?.first_departure;
  return dep ? dep.ply - Number(dep.kind !== "opponent_gap") : 0;
}
function reviewSummary(review, sheet) {
  if (!review.comparison?.source_available) return "Authored preparation unavailable";
  const dep = review.comparison.first_departure;
  if (!dep) return "All played moves matched";
  const move = sheet[dep.ply-1];
  if (dep.kind === "learner_move") {
    const pos = review.positions[dep.ply-1];
    const prepared = pos.prepared_uci.map(m => notation(pos.fen,m)).join(" / ");
    return prepared ? "Review " + prepared + " · you played " + move : move + " differed from preparation";
  }
  if (dep.kind === "opponent_gap") return move + " is outside the prepared replies";
  if (dep.kind === "authored_endpoint") return "Saved line ended before " + move;
  return move + " is outside the authored opening";
}
function markKey(address) {
  return "tempo.game-review.v1." + JSON.stringify([address.dataset_id, address.source, address.game_id, address.learner, address.repertoire_id]);
}
export function readReviewMark(address) {
  try { return JSON.parse(localStorage.getItem(markKey(address))); } catch { return null; }
}
function ExploreEvidence({ fen, book, dataset, revision, legal, play }) {
  const evidence = usePositionEvidence(fen, "repertoire", {
    dataset_id: dataset, learner_color: book.learner_color, repertoire_id: book.id,
  }, revision, legal);
  if (evidence.error) return <p role="status">Preparation unavailable · {evidence.error}</p>;
  if (!evidence.data) return <p>Checking this position…</p>;
  const exact = evidence.data.exact.filter(row => row.repertoire_id === book.id);
  return exact.length ? <div className="move-choices">{exact.map(m => <button key={m.uci}
    onClick={() => play(m.uci)}>Prepared · {legal.get(m.uci).san}</button>)}</div> :
    <p>No saved answer was returned for this position.</p>;
}

function CandidateMoves({ fen, book, review, legal, play, locked }) {
  const [retry, setRetry] = useState(0);
  const fish = usePositionEvidence(fen, "stockfish", {pins:[]}, retry, legal);
  const repertoire = usePositionEvidence(fen, "repertoire", {dataset_id:review.dataset_id,
    learner_color:review.learner_color, repertoire_id:book?.id}, [review.revision, retry], legal);
  const fromWhite = new Chess(fen).turn() === "w" ? 1 : -1;
  const suggestions = repertoire.data?.similar_responses?.current ?? [];
  return <div className="candidate-panel">
    <h3>Stockfish candidates</h3>
    {fish.error ? <p role="status">{fish.error}</p> : !fish.data ? <p>Analyzing position…</p> :
      <><div className="move-choices">{fish.data.candidates.map(row => {
        const value = row.mate != null ? "Mate " + row.mate * fromWhite :
          new Intl.NumberFormat(undefined,{signDisplay:"always",minimumFractionDigits:2,maximumFractionDigits:2}).format(row.centipawns * fromWhite / 100);
        return <button key={row.uci} disabled={locked} onClick={() => play(row.uci)}>{legal.get(row.uci).san} · {value}</button>;
      })}</div><small>Positive scores favor White.</small></>}
    {book && <><h3>Nearby repertoire examples</h3>
      {repertoire.error ? <p role="status">{repertoire.error}</p> : !repertoire.data ? <p>Checking nearby positions…</p> :
        suggestions.length ? <div className="move-choices">{suggestions.map(row =>
          <button key={row.uci} disabled={locked} onClick={() => play(row.uci)}>{legal.get(row.uci).san} · {row.position_count} nearby</button>)}</div> :
          <p>No reusable move found in nearby positions.</p>}</>}
    {(fish.error || repertoire.error) && <button className="inline-link" onClick={() => setRetry(n => n+1)}>Retry candidate analysis</button>}
  </div>;
}

export function GameWorkbench({ address, dataset, books, onClose, changeBook, onSaved }) {
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState({});
  const [notice, setNotice] = useState("");
  const [locked, setLocked] = useState(false);
  const book = books.find(item => item.id === address.repertoire_id);
  const key = JSON.stringify([dataset, address.dataset_id, address.source, address.game_id, address.learner, address.repertoire_id, address.ply, address.branch, address.start, attempt]);
  useEffect(() => {
    if (!dataset) return;
    const abort = new AbortController();
    async function loadReview() {
      try {
        if (address.dataset_id !== dataset || !address.source || !address.game_id || !address.learner)
          throw new Error("This game link does not identify a game in the current dataset.");
        if (address.repertoire_id && !book) throw new Error("The selected repertoire is no longer available.");
        const request = { dataset_id: dataset, source: address.source, game_id: address.game_id,
          learner: address.learner, repertoire_id: address.repertoire_id };
        const review = await readGameReview(request, abort.signal);
        if (address.ply !== null && address.ply !== undefined &&
            (!Number.isSafeInteger(address.ply) || address.ply < 0 || address.ply >= review.positions.length))
          throw new Error("The linked move is outside this game. Open the opening decision to continue.");
        if (address.start != null && (!Number.isSafeInteger(address.start) || address.start < 0 || address.start > address.ply))
          throw new Error("The linked starting move is outside the selected line.");
        try { lineText(review.positions[address.ply ?? decisionPly(review.comparison)].fen, address.branch ?? []); }
        catch { throw new Error("The linked variation cannot be played from this position."); }
        const sheet = review.positions.slice(0, -1).map(p => notation(p.fen, p.played_uci));
        if (!abort.signal.aborted) {
          const active = reviewAddress() ?? address;
          const visited = {...active, ply:active.ply ?? decisionPly(review.comparison)};
          if (book) rememberVisit(visited, {comparison:{repertoire_id:book.id, name:book.name,
            document_id:review.document_id, text:reviewSummary(review,sheet)}});
          setLoad({ key, review, sheet });
        }
      } catch (e) { if (!abort.signal.aborted) setLoad({ key, error: e.message }); }
    }
    void loadReview();
    return () => abort.abort();
  }, [key, book?.id]);
  const current = load.key === key ? load : {};
  return <main className="tempo-core review-page">
    <header className="review-header"><div>
      <button className="return-link" disabled={locked} onClick={onClose}>← Games</button>
      <h1>{current.review ? current.review.white + " vs " + current.review.black : "Game review"}</h1>
      {current.review && <p>{address.learner} as {current.review.learner_color} · {current.review.result}</p>}
    </div><label>Destination repertoire
      <select value={address.repertoire_id || ""} disabled={locked}
        onChange={e => { setNotice(""); changeBook(e.target.value || null); }}>
        <option value="">Select a repertoire</option>
        {books.filter(b => !current.review || b.learner_color === current.review.learner_color).map(b =>
          <option key={b.id} value={b.id}>{b.name} · {b.learner_color}</option>)}
      </select>
    </label></header>
    {notice && <p role="status" className="review-saved">{notice}</p>}
    {current.error ? <section className="review-card" role="alert"><p>{current.error}</p><Button onClick={() => setAttempt(n => n + 1)}>Retry review</Button> <Button onClick={() => changeBook(book?.id || null)}>Open opening decision</Button></section>
      : current.review ? <ReviewBoard key={key} address={address} review={current.review} sheet={current.sheet}
        book={book} locked={locked} setLocked={setLocked} onSaved={label => {
          setNotice(label); onSaved(); setAttempt(n => n + 1);
        }} onReload={() => setAttempt(n => n + 1)} />
      : <p role="status">Opening game…</p>}
  </main>;
}

function ReviewBoard({ address, review, sheet, book, locked, setLocked, onSaved, onReload }) {
  const { positions, comparison } = review;
  const initial = new URLSearchParams(window.location.hash.split("?")[1]);
  const wantedPly = initial.has("ply") ? Number(initial.get("ply")) : decisionPly(comparison);
  const [ply, setPly] = useState(Number.isSafeInteger(wantedPly) && wantedPly >= 0 && wantedPly < positions.length ? wantedPly : 0);
  const [start, setStart] = useState(() => {
    const requested = initial.has("start") ? Number(initial.get("start")) : Math.max(0, (comparison?.first_departure?.ply ?? 1) - 1);
    return Number.isSafeInteger(requested) && requested >= 0 && requested <= ply ? requested : ply;
  });
  const [branch, setBranch] = useState(() => {
    const moves = initial.get("branch")?.split(" ").filter(Boolean) || [];
    try { lineText(positions[ply].fen, moves); return moves; } catch { return []; }
  });
  const [choice, setChoice] = useState(null);
  const [candidates, setCandidates] = useState(false);
  const [preview, setPreview] = useState(null);
  const [issue, setIssue] = useState("");
  const [pending, setPending] = useState(null);
  const [marker, setMarker] = useState(() => readReviewMark(address));
  const boardInput = useRef(null);
  const flight = useRef(false);
  const current = positions[ply];
  const board = useMemo(() => {
    const result = new Chess(current.fen);
    branch.forEach(move => playBoardMove(result, move));
    return result;
  }, [current, branch]);
  const fen = board.fen();
  const legal = useMemo(() => new Map(board.moves({verbose:true}).map(m => [m.lan, m])), [board]);
  const destinations = new Map();
  for (const m of legal.values()) destinations.set(m.from, [...new Set([...(destinations.get(m.from) || []), m.to])]);
  const dep = comparison?.first_departure;
  const decision = decisionPly(comparison);
  const inBranch = branch.length > 0;
  const prepared = current.prepared_uci;
  const lastBranchMove = board.history({verbose:true}).at(-1);
  const endpoint = lastBranchMove ? notation(lastBranchMove.before, lastBranchMove.lan) : ply > 0 ? sheet[ply - 1] : "Starting position";
  let anchor = start;
  while (anchor >= 0 && !["position", "endpoint"].includes(positions[anchor].book_state)) anchor--;
  const path = anchor >= 0 ? [...positions.slice(anchor, ply).map(p => p.played_uci), ...branch] : [];
  const alternate = current.other_route;
  const transpositionPly = positions.findIndex(p => p.other_route !== null);
  const lastMove = branch.at(-1) || positions[ply - 1]?.played_uci;
  function navigate(next, variation = [], nextStart = Math.min(start,next)) {
    if (flight.current || pending) return;
    setStart(nextStart); setPly(next); setBranch(variation); setChoice(null); setPreview(null); setIssue("");
    boardInput.current?.clearInput();
    const location = { ...address, ply: next, branch: variation, start:nextStart };
    window.history.replaceState(null, "", reviewUrl(location));
    rememberVisit(location);
  }
  function play(move) {
    if (locked || !legal.has(move)) return;
    if (!inBranch && move === current.played_uci) navigate(ply + 1);
    else navigate(ply, [...branch, move]);
  }
  function stepBack() { inBranch ? navigate(ply, branch.slice(0, -1)) : navigate(Math.max(0, ply - 1)); }
  useEffect(() => {
    function keydown(e) {
      if (locked || choice || e.altKey || e.ctrlKey || e.metaKey || e.target.closest?.("input,select,textarea,button")) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); stepBack(); }
      if (e.key === "ArrowRight" && !inBranch && ply < sheet.length) { e.preventDefault(); navigate(ply + 1); }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });
  async function command(save) {
    if (flight.current || !book) return;
    flight.current = true; setLocked(true); setIssue("");
    let recover = !!pending;
    try {
      if (!save) {
        setPreview(null);
        const doc = await sendRepertoireCommand({command:"read_document", dataset_id:review.dataset_id, repertoire_id:book.id}, AbortSignal.timeout(20000));
        if (doc.status !== "document" || doc.dataset_id !== review.dataset_id || doc.repertoire_id !== book.id ||
            doc.revision !== review.revision || doc.document.status !== "available")
          throw new Error("The repertoire changed or its document is unavailable. Reload the comparison.");
        const source = {dataset_id:review.dataset_id, source:review.source, game_id:review.game_id,
          learner:review.learner, repertoire_id:book.id};
        const [r, annotated] = await Promise.all([
          sendRepertoireCommand({ command:"marked_preview", dataset_id:review.dataset_id, repertoire_id:book.id,
            name:doc.name, learner_color:doc.learner_color, base_revision:doc.revision,
            anchor_fen:positions[anchor].fen, lines:[path] }, AbortSignal.timeout(20000)),
          readGameReview({...source, line:{from_ply:anchor,moves:path}}, AbortSignal.timeout(20000)),
        ]);
        if (annotated.revision !== review.revision || annotated.document_id !== review.document_id)
          throw new Error("The repertoire changed. Reload the comparison.");
        if (r.status !== "preview") throw new Error(r.message || "Preview unavailable.");
        setPreview({ ...r, edges:annotated.line, conflict: !!(r.changed || r.removed || r.affected_learning || r.replacements.length || r.retired_routes.length),
          unchanged: doc.document.pgn === r.save_command.pgn });
      } else {
        if (!preview || preview.conflict || preview.unchanged) return;
        const cmd = pending || preview.save_command;
        if (!pending) {
          if (hasPendingRepertoireCommand()) throw new Error("Reload to recover the pending repertoire save.");
          await savePendingRepertoireCommand(cmd); setPending(cmd); recover = true;
        }
        const result = await sendRepertoireCommand(cmd, AbortSignal.timeout(20000));
        if (result.status === "error" && result.retryable) throw new Error(result.message);
        await savePendingRepertoireCommand(null); setPending(null); recover = false;
        if (result.status !== "repertoires") { setPreview(null); throw new Error(result.message || "Save was declined."); }
        window.history.replaceState(null, "", reviewUrl({ ...address, ply, branch, start }));
        rememberVisit({...address, ply, branch, start}, {saved:{endpoint, repertoire_id:book.id, name:cmd.name, at:Date.now()}});
        onSaved("Saved through " + endpoint + " to " + cmd.name + ".");
      }
    } catch (e) { setIssue(e.message); }
    finally { flight.current = false; setLocked(recover); }
  }
  function markReviewed() {
    const next = marker?.document_id === review.document_id ? null : { document_id: review.document_id, revision: review.revision };
    try { localStorage.setItem(markKey(address), JSON.stringify(next)); setMarker(next); }
    catch { setIssue("Your browser could not save the review marker."); }
  }
  return <div className="review-grid"><section className="board-column">
    <div className="review-board">
      <Board ref={boardInput} fen={fen} orientation={review.learner_color} turn={board.turn() === "w" ? "white" : "black"}
        mode="legal" locked={locked || !!choice} destinations={destinations} coordinates="edges"
        positionIdentity={fen} positionRevision={ply + branch.length} ariaLabel="Game review board"
        lastMove={lastMove ? [lastMove.slice(0,2),lastMove.slice(2,4)] : undefined}
        check={board.isCheck() ? (board.turn() === "w" ? "white" : "black") : false} onMove={e => {
          if (e.positionIdentity !== fen || e.positionRevision !== ply + branch.length) return;
          const base = e.from + e.to;
          if (legal.has(base)) play(base);
          else {
            const roles = [...legal.keys()].filter(m => m.startsWith(base) && m.length === 5).map(m => m[4]);
            if (roles.length) setChoice({base,moves:roles});
          }
        }}/>
    </div>
    <div className="board-caption"><strong>{colorName(board.turn())} to move</strong><span>{inBranch ? "Exploring from " + (sheet[ply - 1] || "the start") : endpoint}</span></div>
    <div className="review-nav"><Button disabled={locked || (!ply && !inBranch)} onClick={stepBack}>← Previous</Button>
      {inBranch ? <Button disabled={locked} onClick={() => navigate(ply)}>Return to played line</Button>
        : <Button disabled={locked || ply === sheet.length} onClick={() => navigate(ply + 1)}>Next move →</Button>}</div>
    <label className="explore-move">Explore a move <select value="" disabled={locked} onChange={e => play(e.target.value)}>
      <option value="">Choose a legal move…</option>{[...legal].map(([m, v]) => <option key={m} value={m}>{v.san}</option>)}
    </select></label>
    {inBranch && <p className="branch-line"><strong>Explored line</strong> {lineText(current.fen, branch)}</p>}
  </section><div className="review-side">
    <section className="review-card"><div className="card-heading"><h2>Opening decision</h2><span>Current repertoire</span></div>
      {!book ? <p>Select the repertoire you want to compare.</p> : !comparison?.source_available ?
        <p>The authored comparison is unavailable.</p> : dep ? <>
          <button className="decision-link" disabled={locked} onClick={() => navigate(decision, [], Math.max(0,dep.ply-1))}>{sheet[dep.ply - 1]} · {departures[dep.kind]}</button>
          {dep.kind === "learner_move" && <p>Prepared here · {positions[dep.ply - 1].prepared_uci.map(m => san(positions[dep.ply - 1].fen,m)).join(", ") || "Unavailable"}</p>}
        </> : <p>The played line matches the current repertoire through the end of this game.</p>}
      {transpositionPly > 0 && <p><button className="inline-link" disabled={locked} onClick={() => navigate(transpositionPly)}>See move-order transposition at {sheet[transpositionPly-1]}</button></p>}
      {comparison?.reentry_ply && <button className="inline-link" disabled={locked} onClick={() => navigate(comparison.reentry_ply - 1)}>Back in preparation before {sheet[comparison.reentry_ply - 1]}</button>}
    </section>
    <section className="review-card"><div className="card-heading"><h2>This position</h2><span>{inBranch ? "Explored line" : "Played line"}</span></div>
      {!inBranch && current.played_uci && <p><button className="inline-link" disabled={locked} onClick={() => navigate(ply+1)}>
        Played next <strong>{notation(current.fen,current.played_uci)}</strong> →</button></p>}
      {book && (!inBranch ? <><p>{states[current.book_state]}{current.introduced === true ? " · Introduced in Study" : current.introduced === false ? " · Not yet introduced in Study" : ""}</p>
        {prepared.length > 0 && <div className="move-choices">{prepared.map(m => <button key={m} disabled={locked} onClick={() => play(m)}>Prepared · {san(current.fen,m)}</button>)}</div>}
        {alternate && <p className="transposition"><strong>Same position by another move order</strong><br/>{lineText(positions[0].fen,alternate)}</p>}
      </> : <ExploreEvidence fen={fen} book={book} dataset={review.dataset_id} revision={review.revision} legal={legal} play={play}/>)}
      <button className="inline-link candidate-toggle" aria-expanded={candidates} onClick={() => setCandidates(value => !value)}>
        {candidates ? "Hide candidate moves" : "Compare candidate moves"}</button>
      {candidates && <CandidateMoves fen={fen} review={review} book={book} legal={legal} play={play} locked={locked}/>}
      {book && <div className="preview-line"><p><strong>Selected line</strong></p>
        <label>Start from <select disabled={locked} value={start}
          onChange={e => navigate(ply,branch,Number(e.target.value))}>
          {positions.slice(0,ply+1).map((_,index) => <option key={index} value={index}>
            {index === 0 ? "Starting position" : "After " + sheet[index-1]}</option>)}
        </select></label>
        {anchor < 0 ? <p>No authored starting position is available for this line.</p> :
          <>{anchor < start && <p>Includes the connecting moves from {anchor ? sheet[anchor-1] : "the starting position"}.</p>}
          {path.length ? <p>{lineText(positions[anchor].fen,path)}</p> : <p>Play a move or advance to choose the end.</p>}</>}
        {path.length > 0 &&
        <Button disabled={locked} onClick={() => command(false)}>Preview through {endpoint}</Button>}</div>}
      {preview && <div className={preview.conflict ? "review-conflict" : "review-preview"}><h3>{preview.conflict ? "Conflicts with saved preparation" : preview.unchanged ? "Already saved" : "Add to " + book.name}</h3>
        {!preview.conflict && !preview.unchanged && !preview.added && <p>New move order connects to existing preparation.</p>}
        <p>{preview.added} new {preview.added === 1 ? "position" : "positions"} · {preview.changed} changed answers · {preview.removed} retired positions</p>
        <ul className="preview-edges">{preview.edges.map((edge,i) => {
          const saved = edge.prepared_uci.includes(edge.uci);
          const learnerMove = edge.fen.split(" ")[1] === review.learner_color[0];
          const label = edge.book_state === "unavailable" ? "Unavailable" : saved ? "Already prepared" :
            learnerMove && edge.prepared_uci.length ? "Different from prepared " + edge.prepared_uci.map(m => san(edge.fen,m)).join(" / ") :
            learnerMove ? "New answer" : "New opponent move";
          return <li key={i}><strong>{notation(edge.fen,edge.uci)}</strong><span>{label}</span></li>;
        })}</ul>
        {preview.replacements.map((r,i) => <p key={i}>{r.route} · {r.old_move} → {r.new_move}</p>)}
        {preview.retired_routes.map((r,i) => <p key={i}>Would retire {r}</p>)}
        {preview.conflict ? <p>Saving is blocked here. Choose a continuation that preserves the existing answers and lines.</p>
          : preview.unchanged ? <p>This continuation is already in {book.name}.</p> :
          <Button disabled={locked && !pending || flight.current} onClick={() => command(true)}>{pending ? "Retry same save" : "Save selected line"}</Button>}
      </div>}
      {issue && <div role="alert"><p>{issue}</p>{!locked && <Button onClick={onReload}>Reload comparison</Button>}</div>}
    </section>
    <section className="review-card"><div className="card-heading"><h2>Played moves</h2><button className="inline-link" disabled={locked} onClick={() => navigate(0)}>Starting position</button></div>
      <div className="move-sheet">{sheet.map((label,i) => <button key={i} disabled={locked} aria-current={!inBranch && ply === i + 1 ? "step" : undefined}
        className={dep?.ply === i + 1 ? "has-decision" : ""} onClick={() => navigate(i+1)}>{label}</button>)}</div>
    </section>
    {book && review.document_id != null && <section className="review-footer">
      <span>{marker?.document_id === review.document_id ? "Marked reviewed on this browser" : marker ? "Repertoire changed since your review" : "Not marked reviewed"}</span>
      <button className="inline-link" disabled={locked} onClick={markReviewed}>{marker?.document_id === review.document_id ? "Reopen review" : "Mark reviewed"}</button>
    </section>}
  </div><PromotionChooser choice={choice} onChoose={(c,r) => play(c.base+r)} onCancel={() => {setChoice(null);boardInput.current?.clearInput();}}/></div>;
}

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Board, Button } from "@tempo-v2/core-components";
import { Chess } from "chess.js";
import { readGameReview } from "./game_commands.js";
import { deliverDurableRepertoireCommand, previewMarkedLines, recoveryCleanupNotice, sendRepertoireCommand } from "./repertoire_commands.js";
import { playBoardMove } from "./board_move.js";
import { PromotionChooser } from "./PromotionChooser.jsx";
import { usePositionEvidence } from "./position_evidence.js";
import { ReviewMoveTable } from "./ReviewMoveTable.jsx";
import { loadBoardPreferences } from "./BoardPreferences.jsx";
import { createBoardSounds, learnerCue } from "./board_sounds.js";
import { promotionRoles } from "./promotion_roles.js";
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
export function GameWorkbench({ address, dataset, books, recordedComparisons, onClose, changeBook, onSaved }) {
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState({});
  const [notice, setNotice] = useState("");
  const [savedSelection,setSavedSelection] = useState(null);
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
  const opening = {ply:null, start:null, branch:[]};
  function switchBook(id) {
    setNotice(""); setSavedSelection(null);
    const cursor = reviewAddress();
    if (cursor?.ply != null) {
      changeBook(id, {ply:cursor.ply, start:cursor.start, branch:cursor.branch});
    } else if (book && current.review) {
      const comparison = current.review.comparison;
      changeBook(id, {ply:decisionPly(comparison), start:Math.max(0,(comparison?.first_departure?.ply ?? 1)-1), branch:[]});
    } else changeBook(id, opening);
  }
  return <main className="tempo-core review-page">
    <header className="review-header"><div>
      <button className="return-link" disabled={locked} onClick={onClose}>← Games</button>
      <h1>{current.review ? current.review.white + " vs " + current.review.black : "Game review"}</h1>
      {current.review && <p>{address.learner} as {current.review.learner_color} · {current.review.result}</p>}
    </div><label>Destination repertoire
      <select value={address.repertoire_id || ""} disabled={locked}
        onChange={e => switchBook(e.target.value || null)}>
        <option value="">Select a repertoire</option>
        {books.filter(b => !current.review || b.learner_color === current.review.learner_color).map(b =>
          <option key={b.id} value={b.id}>{b.name} · {b.learner_color}</option>)}
      </select>
    </label></header>
    {notice && <p role="status" className="review-saved">{notice}</p>}
    {current.error ? <section className="review-card" role="alert"><p>{current.error}</p><Button onClick={() => setAttempt(n => n + 1)}>Retry review</Button> <Button onClick={() => changeBook(book?.id || null, opening)}>Open opening decision</Button></section>
      : current.review ? <ReviewBoard key={key} address={address} review={current.review} sheet={current.sheet}
        recorded={recordedComparisons?.find(r=>r.repertoire_id===book?.id)} book={book} locked={locked} setLocked={setLocked} savedSelection={savedSelection} onSaved={(label,selection) => {
          setSavedSelection(selection);
          setNotice(label); onSaved(); setAttempt(n => n + 1);
        }} onReload={() => setAttempt(n => n + 1)} />
      : <p role="status">Opening game…</p>}
  </main>;
}

function ReviewBoard({ address, review, sheet, recorded, book, locked, setLocked, savedSelection, onSaved, onReload }) {
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
  const [arrows,setArrows] = useState(true);
  const [circle,setCircle] = useState(null);
  const [engineMarks,setEngineMarks] = useState(null);
  const [prefs] = useState(loadBoardPreferences);
  const [sounds] = useState(() => createBoardSounds(prefs.volume));
  useEffect(() => { void sounds.prepare(); return () => sounds.cancel(); }, [sounds]);
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
  const recordedDeparture = recorded?.first_departure;
  const changedFinding = recorded && comparison && (
    recorded.source_available !== comparison.source_available ||
    recordedDeparture?.kind !== dep?.kind || recordedDeparture?.ply !== dep?.ply
  );
  const recordedText = !recorded?.source_available ? "Preparation was unavailable" :
    !recordedDeparture ? "All played moves matched" :
    [sheet[recordedDeparture.ply-1], departures[recordedDeparture.kind]].filter(Boolean).join(" · ");
  const decision = decisionPly(comparison);
  const inBranch = branch.length > 0;
  const branchEvidence = usePositionEvidence(fen,"repertoire",{dataset_id:review.dataset_id,
    learner_color:review.learner_color,repertoire_id:book?.id},review.revision,legal,inBranch && !!book);
  const prepared = inBranch ? (branchEvidence.data?.exact || []).filter(row=>row.repertoire_id===book?.id).map(row=>row.uci) : current.prepared_uci;
  const lastBranchMove = board.history({verbose:true}).at(-1);
  const endpoint = lastBranchMove ? notation(lastBranchMove.before, lastBranchMove.lan) : ply > 0 ? sheet[ply - 1] : "Starting position";
  let anchor = start;
  while (anchor >= 0 && !["position", "endpoint"].includes(positions[anchor].book_state)) anchor--;
  const path = anchor >= 0 ? [...positions.slice(anchor, ply).map(p => p.played_uci), ...branch] : [];
  const selection = JSON.stringify([review.dataset_id,review.game_id,review.source,review.learner,book?.id,anchor,path]);
  const alternate = current.other_route;
  const transpositionPly = positions.findIndex(p => p.other_route !== null);
  const lastMove = branch.at(-1) || positions[ply - 1]?.played_uci;
  const exactLearner = book && board.turn() === review.learner_color[0];
  const shapes = candidates && engineMarks?.fen === fen ? [...engineMarks.shapes] : [];
  if (arrows && exactLearner && prepared.length) {
    const played = !inBranch && current.played_uci;
    const arrows = prepared.map(move => ({move, brush:"green"}));
    if (played && !prepared.includes(played)) arrows.push({move:played, brush:"red"});
    // On one diagonal, the shorter arrowhead must stay visible within the longer arrow.
    const length = ({move}) => Math.max(Math.abs(move.charCodeAt(0)-move.charCodeAt(2)), Math.abs(Number(move[1])-Number(move[3])));
    arrows.sort((a,b) => length(b)-length(a));
    for (const {move, brush} of arrows) shapes.push({orig:move.slice(0,2),dest:move.slice(2,4),brush});
  }
  if (circle && legal.has(circle)) shapes.push({orig:circle.slice(2,4),brush:"blue"});
  const draftLine = inBranch || (!!dep && dep.kind !== "learner_move" && ply >= decision);
  function navigate(next, variation = [], nextStart = Math.min(start,next)) {
    if (flight.current || pending) return;
    setStart(nextStart); setPly(next); setBranch(variation); setChoice(null); setPreview(null); setIssue("");
    setCircle(null);
    const location = { ...address, ply: next, branch: variation, start:nextStart };
    window.history.replaceState(window.history.state, "", reviewUrl(location));
    rememberVisit(location);
  }
  function play(move) {
    if (locked || !legal.has(move)) return;
    sounds.play(learnerCue(fen,move));
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
          previewMarkedLines({ dataset_id:review.dataset_id, repertoire_id:book.id,
            name:doc.name, learner_color:doc.learner_color, base_revision:doc.revision,
            anchor_fen:positions[anchor].fen, lines:[path] }, AbortSignal.timeout(20000)),
          readGameReview({...source, line:{from_ply:anchor,moves:path}}, AbortSignal.timeout(20000)),
        ]);
        if (annotated.revision !== review.revision || annotated.document_id !== review.document_id)
          throw new Error("The repertoire changed. Reload the comparison.");
        const unchanged = doc.document.pgn === r.save_command.pgn;
        setPreview({ ...r, edges:annotated.line, conflict: !!(r.changed || r.removed || r.affected_learning || r.replacements.length || r.retired_routes.length),
          unchanged });
      } else {
        if (!preview || preview.conflict || preview.unchanged) return;
        const cmd = pending || preview.save_command;
        const { reply: result, cleanupNeeded } = await deliverDurableRepertoireCommand(cmd, {
          stored: !!pending, signal: AbortSignal.timeout(20_000),
          onPending(next) { setPending(next); recover = !!next; },
        });
        if (result.status === "error") {
          if (!result.retryable) setPreview(null);
          throw new Error([result.message, cleanupNeeded && recoveryCleanupNotice].filter(Boolean).join(" "));
        }
        window.history.replaceState(window.history.state, "", reviewUrl({ ...address, ply, branch, start }));
        rememberVisit({...address, ply, branch, start}, {saved:{endpoint, repertoire_id:book.id, name:cmd.name, at:Date.now()}});
        onSaved("Saved through " + endpoint + " to " + cmd.name + "." + (cleanupNeeded ? " " + recoveryCleanupNotice : ""),selection);
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
      <Board shapes={shapes} theme={prefs.theme} pieceSet={prefs.pieceSet} retainMoveOnLock={!!choice} ref={boardInput} fen={fen} orientation={review.learner_color} turn={board.turn() === "w" ? "white" : "black"}
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
    <div className="review-board-tools"><label><input type="checkbox" checked={arrows} onChange={e=>setArrows(e.target.checked)}/> Prepared and played arrows</label>
      <details><summary>Enter a move</summary><form onSubmit={e=>{
        e.preventDefault();
        const field=e.currentTarget.elements.move;
        const input=field.value.trim();
        const move=[...legal.values()].find(m=>m.lan===input || m.san===input);
        if (move) {field.value=""; play(move.lan);}
        else {field.setCustomValidity("Enter a legal move, such as Nf3 or g1f3."); field.reportValidity();}
      }}><label>Chess move <input name="move" disabled={locked} onInput={e=>e.target.setCustomValidity("")}/></label><button disabled={locked}>Play move</button></form></details></div>
    {inBranch && <p className="branch-line"><strong>Variation</strong> {lineText(current.fen, branch)}</p>}
  </section><div className="review-side">
    <section className="review-card"><div className="card-heading"><h2>Opening decision</h2><span>Current repertoire</span></div>
      {!book ? <p>Select the repertoire you want to compare.</p> : !comparison?.source_available ?
        <p>The authored comparison is unavailable.</p> : dep ? <>
          <button className="decision-link" disabled={locked} onClick={() => navigate(decision, [], Math.max(0,dep.ply-1))}>{sheet[dep.ply - 1]} · {departures[dep.kind]}</button>
          {dep.kind === "learner_move" && <p>Prepared here · {positions[dep.ply - 1].prepared_uci.map(m => san(positions[dep.ply - 1].fen,m)).join(", ") || "Unavailable"}</p>}
        </> : <p>The played line matches the current repertoire through the end of this game.</p>}
      {changedFinding && <p className="recorded-finding"><small>Earlier comparison · {recordedText}. The decision above uses the current repertoire.</small></p>}
      {transpositionPly > 0 && <p><button className="inline-link" disabled={locked} onClick={() => navigate(transpositionPly)}>See move-order transposition at {sheet[transpositionPly-1]}</button></p>}
      {comparison?.reentry_ply && <button className="inline-link" disabled={locked} onClick={() => navigate(comparison.reentry_ply - 1)}>Back in preparation before {sheet[comparison.reentry_ply - 1]}</button>}
    </section>
    <section className="review-card"><div className="card-heading"><h2>This position</h2><span>{inBranch ? "Explored line" : "Played line"}</span></div>
      {!inBranch && current.played_uci && <p><button className="inline-link" disabled={locked} onClick={() => navigate(ply+1)}>
        Played next <strong>{notation(current.fen,current.played_uci)}</strong> →</button></p>}
      {book && (!inBranch ? <><p>{states[current.book_state]}{current.introduced === true ? " · Introduced in Study" : current.introduced === false ? " · Not yet introduced in Study" : ""}</p>
        {prepared.length > 0 && <div className="move-choices">{prepared.map(m => <button key={m} disabled={locked} onClick={() => play(m)}>Prepared · {san(current.fen,m)}</button>)}</div>}
        {alternate && <p className="transposition"><strong>Same position by another move order</strong><br/>{lineText(positions[0].fen,alternate)}</p>}
      </> : <p>Exploring a variation from the played game.</p>)}
      {exactLearner && prepared.length > 0 && <small>Green shows preparation. Red shows a different played move.</small>}
      <button className="inline-link candidate-toggle" aria-expanded={candidates} onClick={() => {setCandidates(value => !value);setCircle(null);setEngineMarks(null);}}>
        {candidates ? "Hide candidate moves" : "Compare candidate moves"}</button>
      {candidates && <ReviewMoveTable fen={fen} review={review} book={book} legal={legal} prepared={prepared} play={play} locked={locked} circle={circle} setCircle={setCircle} onEngineMarks={setEngineMarks}/>}
      {book && (draftLine || path.length>0) && <div className="preview-line"><h3>{savedSelection===selection ? "Saved line" : draftLine ? "Candidate line" : "Selected line"}</h3>
        {draftLine && savedSelection !== selection && <p>{preview?.unchanged ? "Already in the repertoire." : "Draft · preview before saving to "+book.name+"."}</p>}
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
  </div><PromotionChooser choice={choice} onChoose={(c,r) => {boardInput.current?.previewPromotion(c.base.slice(2),promotionRoles[r].toLowerCase()); play(c.base+r);}} onCancel={() => {setChoice(null);boardInput.current?.clearInput();}}/></div>;
}

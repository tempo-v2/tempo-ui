import React, { useLayoutEffect, useState } from "react";
import {candidateMoves, engineCells, engineRankShapes, explorerCells, leadingMeasuredMoves, measurementText, probabilityCells} from "./move_evidence.js";
import { usePositionEvidence } from "./position_evidence.js";

const labels = {exact:"Prepared", nearby:"Nearby", stockfish:"Stockfish", rated:"Lichess Rapid", maia:"Maia"};
const descriptions = {
  exact:"Saved answer in the selected repertoire at this position.",
  nearby:"Number of nearby positions in this repertoire with the same legal move.",
  stockfish:"Engine evaluation in pawns. Positive favors White. M indicates an engine-reported mate distance.",
  rated:"Move frequency in the Lichess Rapid 1400–1599 sample. Counts show games with the move.",
  maia:"Predicted move probability for Maia’s Rapid 1500 profile.",
};


export function ReviewMoveTable({ fen, book, review, legal, prepared, played, onPlayedLine, repertoireEvidence,
  retryRepertoire, play, locked, circle, setCircle, onEngineMarks }) {
  const [columns,setColumns] = useState(Object.keys(labels));
  const [enabled,setEnabled] = useState({exact:true,nearby:true,stockfish:true});
  const [count,setCount] = useState(3);
  const [retry,setRetry] = useState(0);
  const [sortOverride,setSortOverride] = useState(null);
  const whiteToMove = fen.split(" ")[1] === "w";
  const preferredSort = sortOverride ?? {column:"stockfish",desc:whiteToMove};
  const sort = preferredSort.column === "move" || enabled[preferredSort.column] ? preferredSort : {column:"move",desc:false};
  const [showRanks,setShowRanks] = useState(false);
  const repertoire = book ? repertoireEvidence : {error:"Select a repertoire"};
  const fish = usePositionEvidence(fen,"stockfish",{pins:[],candidate_count:count},retry,legal,enabled.stockfish ?? false);
  useLayoutEffect(() => {
    const shapes = showRanks && enabled.stockfish ? engineRankShapes(fish.data?.candidates) : [];
    onEngineMarks({fen, shapes});
  },[fen,fish.data,showRanks,enabled.stockfish,onEngineMarks]);
  const rapid = usePositionEvidence(fen,"rated",{ratings:"around1500"},retry,legal,enabled.rated ?? false);
  const maia = usePositionEvidence(fen,"maia",{},retry,legal,enabled.maia ?? false);
  // The played timeline already carries the authored answers at its addressed version.
  // Exploration receives those facts only after the evidence owner confirms the same document.
  const exactAvailable = !repertoire.stale && !!book && review.comparison?.source_available && (onPlayedLine || !!repertoire.data);
  const replies = {exact:exactAvailable ? {data:true} : repertoire, nearby:repertoire, stockfish:fish, rated:rapid, maia};
  const savedMoves = exactAvailable ? prepared : [];
  const values = {
    exact:Object.fromEntries(savedMoves.map(move => [move,{score:1,text:"Saved"}])),
    nearby:Object.fromEntries((repertoire.data?.similar_responses.current ?? [])
      .map(row => [row.uci,{score:row.position_count,text:String(row.position_count)}])),
    stockfish:engineCells(fen,fish.data), rated:explorerCells(rapid.data), maia:probabilityCells(maia.data),
  };
  const rows = candidateMoves(legal, [
    savedMoves, [played, circle],
    ...(enabled.nearby ? [leadingMeasuredMoves(values.nearby)] : []),
    ...(enabled.stockfish ? [Object.keys(values.stockfish)] : []),
    ...(enabled.rated ? [leadingMeasuredMoves(values.rated)] : []),
    ...(enabled.maia ? [leadingMeasuredMoves(values.maia)] : []),
  ]);
  const visible = columns.filter(c => enabled[c]);
  const sorted = rows.sort((a,b) => {
    const first = values[sort.column]?.[a]?.score, second = values[sort.column]?.[b]?.score;
    if (first != null && second == null) return -1;
    if (first == null && second != null) return 1;
    return (first != null && second != null ? (first-second)*(sort.desc?-1:1) : 0)
      || legal.get(a).san.localeCompare(legal.get(b).san);
  });
  function header(key,label) {
    return <th key={key} aria-sort={sort.column===key ? sort.desc ? "descending":"ascending" : undefined}>
      <button onClick={() => setSortOverride({column:key, desc:sort.column===key ? !sort.desc : key==="stockfish" ? whiteToMove : key!=="move"})}>{label}{sort.column===key ? sort.desc?" ↓":" ↑":""}</button></th>;
  }
  if (sort.column==="move" && sort.desc) sorted.reverse();
  return <section className="candidate-panel" aria-label="Move comparison">
    <details><summary>Comparison sources and columns</summary>
      <p>Prepared, played and circled moves stay in the list. Each enabled source contributes up to three ranked moves with positive support, or the number of Stockfish lines you choose.</p>
      {columns.map((key,i) => <div className="review-source" key={key}>
        <label><input type="checkbox" checked={!!enabled[key]} onChange={e=>setEnabled({...enabled,[key]:e.target.checked})}/>{labels[key]}</label>
        <button aria-label={"Move "+labels[key]+" column left"} disabled={!i} onClick={()=>{
          const next=[...columns]; [next[i-1],next[i]]=[next[i],next[i-1]]; setColumns(next);
        }}>←</button><small>{descriptions[key]}{!enabled[key] && " Source off."}</small></div>)}
    </details>
    {enabled.stockfish && <div><label>Stockfish lines <select value={count} onChange={e=>setCount(Number(e.target.value))}>
      {[1,2,3,4,5].map(n=><option key={n}>{n}</option>)}</select></label>{" "}<label><input type="checkbox" checked={showRanks} onChange={e=>setShowRanks(e.target.checked)}/> Stockfish on board</label>
      {showRanks && <small> Numbers show engine rank for the side to move.</small>}</div>}
    {visible.filter(c=>!replies[c].data).map(c=><small key={c} role="status">{labels[c]} · {
      (c==="exact" || c==="nearby") && !book ? "Select a repertoire" : replies[c].error || "Checking position…"}</small>)}
    {Object.values(replies).some(r=>r.error) && <button onClick={()=>{setRetry(n=>n+1);retryRepertoire();}}>Retry sources</button>}
    <div className="review-comparison-scroll"><table><thead><tr>{header("move","Move")}{visible.map(k=>header(k,labels[k]))}<th>Mark</th></tr></thead>
      <tbody>{sorted.map(m=><tr key={m}><td><button disabled={locked} onClick={()=>play(m)}>{legal.get(m).san}</button></td>
        {visible.map(k=><td key={k}>{measurementText(values[k][m],replies[k])}</td>)}
        <td><button aria-label={"Circle "+legal.get(m).san} aria-pressed={circle===m} onClick={()=>setCircle(circle===m?null:m)}>◎</button></td></tr>)}</tbody></table></div>
    {!sorted.length && <p>No candidate moves from the selected sources yet.</p>}
    <small>Positive engine scores favor White. A dash means the source supplied no value for that move.</small>
  </section>;
}

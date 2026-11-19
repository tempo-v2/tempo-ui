import React, { useState } from "react";
import { usePositionEvidence } from "./position_evidence.js";

const labels = {exact:"Prepared", nearby:"Nearby", stockfish:"Stockfish", rated:"Lichess Rapid", maia:"Maia"};
const descriptions = {
  exact:"Saved answer in the selected repertoire at this position.",
  nearby:"Number of nearby positions in this repertoire with the same legal move.",
  stockfish:"Engine evaluation in pawns. Positive favors White. M indicates an engine-reported mate distance.",
  rated:"Move frequency in the Lichess Rapid 1400–1599 sample. Counts show games with the move.",
  maia:"Predicted move probability for Maia’s Rapid 1500 profile.",
};
const pct = n => (n*100).toFixed(1) + "%";

export function ReviewMoveTable({ fen, book, review, legal, prepared, play, locked, circle, setCircle }) {
  const [columns,setColumns] = useState(Object.keys(labels));
  const [enabled,setEnabled] = useState({exact:true,nearby:true,stockfish:true});
  const [count,setCount] = useState(3);
  const [retry,setRetry] = useState(0);
  const [sort,setSort] = useState({column:"stockfish",desc:true});
  const repertoire = usePositionEvidence(fen,"repertoire",{dataset_id:review.dataset_id,
    learner_color:review.learner_color,repertoire_id:book?.id},[review.revision,retry],legal,
    !!book && (enabled.exact || enabled.nearby));
  const fish = usePositionEvidence(fen,"stockfish",{pins:[],candidate_count:count},retry,legal,enabled.stockfish ?? false);
  const rapid = usePositionEvidence(fen,"rated",{ratings:"around1500"},retry,legal,enabled.rated ?? false);
  const maia = usePositionEvidence(fen,"maia",{},retry,legal,enabled.maia ?? false);
  const replies = {exact:repertoire,nearby:repertoire,stockfish:fish,rated:rapid,maia};
  const rows = new Map();
  function cell(move,column,score,text) {
    if (!enabled[column] || !legal.has(move)) return;
    if (!rows.has(move)) rows.set(move,{});
    rows.get(move)[column] = {score,text};
  }
  for (const move of prepared) cell(move,"exact",1,"Saved");
  for (const row of repertoire.data?.exact || []) if (row.repertoire_id === book?.id) cell(row.uci,"exact",1,"Saved");
  for (const row of repertoire.data?.similar_responses.current || []) cell(row.uci,"nearby",row.position_count,row.position_count);
  const sign = fen.split(" ")[1] === "w" ? 1 : -1;
  for (const row of fish.data?.candidates || []) {
    const score = row.centipawns != null ? sign*row.centipawns/100 : null;
    cell(row.uci,"stockfish",score ?? sign*Math.sign(row.mate)*(1e6-Math.abs(row.mate)),
      score == null ? "M" + (sign*row.mate) : (score>0?"+":"") + score.toFixed(2));
  }
  if (rapid.data) {
    const {white,draws,black,moves} = rapid.data;
    for (const row of moves) {
      const n = row.white + row.draws + row.black;
      cell(row.uci,"rated",n,pct(n/(white+draws+black || 1))+" · "+n.toLocaleString());
    }
  }
  for (const [move,p] of Object.entries(maia.data?.probabilities || {})) cell(move,"maia",p,pct(p));
  const visible = columns.filter(c => enabled[c]);
  const sorted = [...rows.keys()].sort((a,b) => {
    const first = rows.get(a)[sort.column]?.score, second = rows.get(b)[sort.column]?.score;
    if (first != null && second == null) return -1;
    if (first == null && second != null) return 1;
    return (first != null && second != null ? (first-second)*(sort.desc?-1:1) : 0)
      || legal.get(a).san.localeCompare(legal.get(b).san);
  });
  function header(key,label) {
    return <th key={key} aria-sort={sort.column===key ? sort.desc ? "descending":"ascending" : undefined}>
      <button onClick={() => setSort({column:key, desc:sort.column===key ? !sort.desc : key!=="move"})}>{label}{sort.column===key ? sort.desc?" ↓":" ↑":""}</button></th>;
  }
  if (sort.column==="move" && sort.desc) sorted.reverse();
  return <section className="candidate-panel" aria-label="Move comparison">
    <details><summary>Comparison sources and columns</summary>
      {columns.map((key,i) => <div className="review-source" key={key}>
        <label><input type="checkbox" checked={!!enabled[key]} onChange={e=>setEnabled({...enabled,[key]:e.target.checked})}/>{labels[key]}</label>
        <button aria-label={"Move "+labels[key]+" column left"} disabled={!i} onClick={()=>{
          const next=[...columns]; [next[i-1],next[i]]=[next[i],next[i-1]]; setColumns(next);
        }}>←</button><small>{descriptions[key]}{!enabled[key] && " Source off."}</small></div>)}
    </details>
    {enabled.stockfish && <label>Stockfish lines <select value={count} onChange={e=>setCount(Number(e.target.value))}>
      {[1,2,3,4,5].map(n=><option key={n}>{n}</option>)}</select></label>}
    {visible.filter(c=>!replies[c].data).map(c=><small key={c} role="status">{labels[c]} · {
      (c==="exact" || c==="nearby") && !book ? "Select a repertoire" : replies[c].error || "Checking position…"}</small>)}
    {Object.values(replies).some(r=>r.error) && <button onClick={()=>setRetry(n=>n+1)}>Retry sources</button>}
    <div className="review-comparison-scroll"><table><thead><tr>{header("move","Move")}{visible.map(k=>header(k,labels[k]))}<th>Mark</th></tr></thead>
      <tbody>{sorted.map(m=><tr key={m}><td><button disabled={locked} onClick={()=>play(m)}>{legal.get(m).san}</button></td>
        {visible.map(k=><td key={k}>{rows.get(m)[k]?.text ?? "—"}</td>)}
        <td><button aria-label={"Circle "+legal.get(m).san} aria-pressed={circle===m} onClick={()=>setCircle(circle===m?null:m)}>◎</button></td></tr>)}</tbody></table></div>
    {!sorted.length && <p>No candidate moves from the selected sources yet.</p>}
    <small>Positive engine scores favor White. A dash means the source supplied no value for that move.</small>
  </section>;
}

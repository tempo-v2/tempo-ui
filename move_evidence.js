// Format measurements independently of the source's contribution to the candidate list.
const percent = n => (100 * n).toFixed(1) + "%";

export function engineCells(fen, data) {
  const sign = fen.split(" ")[1] === "w" ? 1 : -1;
  return Object.fromEntries((data?.candidates ?? []).map(row => {
    if (row.mate != null) {
      const mate = row.mate * sign;
      return [row.uci, {score:Math.sign(mate)*(1e6-Math.abs(mate)), text:"Mate " + mate}];
    }
    const score = row.centipawns * sign / 100;
    return [row.uci, {score, text:(score > 0 ? "+" : "") + score.toFixed(2)}];
  }));
}

export function explorerCells(data) {
  if (!data) return {};
  const total = data.white + data.draws + data.black;
  return Object.fromEntries(data.moves.map(row => {
    const n = row.white + row.draws + row.black;
    const text = total ? percent(n/total) + " · " + n.toLocaleString() : "0 games";
    return [row.uci, {score:n, text, results:[row.white,row.draws,row.black].join("/")}];
  }));
}

export function probabilityCells(data) {
  return Object.fromEntries(Object.entries(data?.probabilities ?? {})
    .sort((a,b) => b[1]-a[1]).map(([move,score]) => [move,{score,text:percent(score)}]));
}

// Review admits prepared, played and explicitly marked moves, plus ranked contributions
// from enabled sources. The Analysis board separately requests every legal move for exploration.
export function candidateMoves(legal, groups) {
  return [...new Set(groups.flat())].filter(move => legal.has(move));
}

export function leadingMeasuredMoves(cells, maximum = 3) {
  return Object.keys(cells).filter(move => cells[move].score > 0)
    .sort((a,b) => cells[b].score - cells[a].score || a.localeCompare(b)).slice(0, maximum);
}

export function moveArrow(move, brush) {
  return {orig:move.slice(0,2), dest:move.slice(2,4), brush};
}

export function engineRankShapes(candidates = []) {
  const ranks = new Map();
  candidates.forEach(({uci},i) => {
    const {dest} = moveArrow(uci,"blue");
    if (!ranks.has(dest)) ranks.set(dest,[]);
    ranks.get(dest).push(i+1);
  });
  return [...ranks].map(([orig,numbers]) => ({
    orig, brush:"blue", label:{text:numbers.join("/"),fill:"#285473"},
  }));
}

export function measurementText(cell, reply) {
  if (cell) return cell.text;
  if (reply.error) return "Unavailable";
  if (!reply.data) return "Checking…";
  return "—";
}

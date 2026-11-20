import React, {useEffect, useEffectEvent, useMemo, useState} from "react";
import {Chess} from "chess.js";
import {Board, Button, StatusNotice, Surface} from "@tempo-v2/core-components";
import {motifNames, readPersonalPosition, readPersonalTactics, tacticalNotation, tacticalScore} from "./tactical_history.js";
import {sourceNames} from "./game_commands.js";

const labels = {
  played_tactic: "Played the tactic", missed_tactic: "Missed tactic", good_alternative: "Sound alternative",
  unclear_play: "Unclear · multiple good moves", unclear_miss: "Unclear · missed the good moves",
  inferior_tactic: "Inferior tactic available", uncertain: "Engine comparison uncertain",
};
const trainingLabels = {
  queued: "Queued in Study",
  issued: "Issued in Study",
  superseded: "Earlier Study card",
  reviewed: "Reviewed in Study",
};
const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const speedNames = {bullet: "Bullet", blitz: "Blitz", rapid: "Rapid", classical: "Classical"};

function clockLabel({seconds, increment}) {
  return Number.isInteger(seconds / 60) ? `${seconds / 60}+${increment}` : `${seconds}s+${increment}`;
}
const total = ({wins, draws, losses}) => wins + draws + losses;
const ratio = (n, d) => d ? n / d : null;
const percent = rate => rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
const percentPoints = rate => `${(rate * 100).toFixed(1)} pp`;
const lossRate = results => ratio(results.losses, total(results));

function Filter({label, value, choices, change}) {
  return <label>{label}<select value={value ?? ""} onChange={event => {
    const option = choices.find(([key]) => String(key) === event.target.value);
    change(option?.[0]);
  }}><option value="">All</option>{choices.map(([key, label]) =>
    <option key={String(key)} value={String(key)}>{label}</option>)}</select></label>;
}

function LoadFilter({label, value, change}) {
  const input = (end, index) => <input aria-label={`${label} ${end}`} type="number" min="0"
    placeholder={end} value={value?.[index] ?? ""} onChange={event => {
      const next = [...(value ?? ["",""])];
      next[index] = event.target.value;
      change(next);
    }}/>;
  return <fieldset><legend>{label}</legend>{input("Min", 0)} {input("Max", 1)}</fieldset>;
}

function LossComparison({view}) {
  const report = view.loss_comparison;
  const miss = lossRate(report.with_miss);
  const clean = lossRate(report.without_miss);
  return <section>
    <h3>Do missed tactics go with losses?</h3>
    <p>{report.analyzed} of {view.filtered_games} matching games fully analyzed. This comparison uses games with a qualifying chance.</p>
    <table className="tactical-captures">
      <thead><tr><th scope="col">Games</th><th scope="col">Win–draw–loss</th><th scope="col">Loss rate</th></tr></thead>
      <tbody>{[[report.with_miss, "At least one miss"], [report.without_miss, "Zero misses"]].map(([group, label]) =>
        <tr key={label}><th scope="row">{label}</th><td>{group.wins}–{group.draws}–{group.losses}</td><td>{percent(lossRate(group))}</td></tr>)}</tbody>
    </table>
    {miss !== null && clean !== null && <p>Loss-rate difference {percentPoints(miss - clean)}.</p>}
    <details><summary>Compare by number of tactical chances</summary>
      <table className="tactical-captures">
        <thead><tr><th>Chances per game</th><th>With a miss</th><th>With zero misses</th></tr></thead>
        <tbody>{report.opportunity_counts.map(([zero, missed], i) => <tr key={i}><th scope="row">{i === 2 ? "3+" : i + 1}</th>
          <td>{percent(lossRate(missed))} ({total(missed)})</td><td>{percent(lossRate(zero))} ({total(zero)})</td></tr>)}</tbody>
      </table>
    </details>
  </section>;
}

function PlayingLoad({title, pattern}) {
  return <section>
    <h4>{title}</h4>
    <table className="tactical-captures">
      <thead><tr><th scope="col">Earlier games</th><th scope="col">Loss rate</th><th scope="col">Miss rate</th><th scope="col">Days</th></tr></thead>
      <tbody>{pattern.bands.map((band, index) => {
        const next = pattern.bands[index + 1];
        return <tr key={band.min}><th scope="row">{next ? `${band.min}–${next.min - 1}` : `${band.min}+`}</th>
          {[[band.results.losses, total(band.results)], [band.misses, band.opportunities]].map(([n,d], metric) =>
            <td key={metric}>{d > 0 && <meter min="0" max="1" value={n/d} aria-label={metric ? "Share of chances missed" : "Share of games lost"}/>}
              {" "}{percent(ratio(n,d))} ({n}/{d})</td>)}
          <td>{band.days}</td></tr>;
      })}</tbody>
    </table>
    {pattern.possible_break && <p><strong>Possible break point after {pattern.possible_break.min} games.</strong>{" "}
      Compared with early play, the matched loss-rate increase was {percentPoints(pattern.possible_break.difference)} across {pattern.possible_break.days} days.</p>}
  </section>;
}

function Finding({row, detail, dataset, onOpen, onSimilar}) {
  const {fen, side_to_move: side, assessment} = detail.details;
  const [line, setLine] = useState(null);
  const [ply, setPly] = useState(0);
  const board = new Chess(fen);
  for (const {uci} of line?.moves.slice(0, ply) ?? []) {
    board.move({from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]});
  }
  const turn = board.turn() === "w" ? "white" : "black";
  const scores = new Map((assessment.analysis.evaluation?.roots ?? []).map(root => [root.uci, root.score]));
  return <article className="tactical-observation" aria-label="Selected tactical opportunity">
    <div className="tactical-position">
      <Board fen={board.fen()} positionIdentity={`${dataset}:${row.id}:${line?.id ?? "start"}`} positionRevision={ply} check={board.inCheck()}
        mode="legal" orientation={side} turn={turn} readOnly maxSize={340} coordinates="edges" ariaLabel="Tactical opportunity position"/>
      {line && <div className="tactical-pages" aria-label="Tactical line controls">
        <Button size="compact" variant="quiet" disabled={ply === 0} onClick={() => setPly(ply - 1)}>Previous move</Button>
        <Button size="compact" variant="quiet" disabled={ply >= line.moves.length} onClick={() => setPly(ply + 1)}>Next move</Button>
        <Button size="compact" variant="quiet" onClick={() => {setLine(null); setPly(0);}}>Reset board</Button>
      </div>}
    </div>
    <div className="tactical-comparison">
      <h3>{labels[row.outcome] ?? row.outcome}</h3>
      <p>{sourceNames[row.game.source] ?? row.game.source} · {row.game.result} · Game {row.game.id}</p>
      <p>You played <strong>{tacticalNotation(fen, assessment.played.uci)}</strong> · {tacticalScore(scores.get(assessment.played.uci) ?? null)}</p>
      {onOpen && <Button variant="quiet" onClick={() => onOpen({dataset_id: dataset, source:row.game.source,
        game_id:row.game.id, learner:row.game.learner, repertoire_id:null, ply:row.ply, start:row.ply, branch:[]})}>Open source game</Button>}
      <Button variant="quiet" onClick={() => onSimilar(row.id)}>Similar positions</Button>
      {detail.training !== null && <p>{trainingLabels[detail.training.status]}</p>}
      <table className="tactical-captures"><thead><tr><th>Motif</th><th>Move</th><th>Evaluation</th><th>Pieces involved</th></tr></thead>
        <tbody>{assessment.personal.candidates.map((candidate, index) => <tr key={index}>
          <th scope="row">{motifNames[candidate.motif]}</th>
          <td><Button size="compact" variant="quiet" onClick={() => {
            setLine({id:index, moves:[candidate.answer,...candidate.continuation]}); setPly(1);
          }}>{tacticalNotation(fen, candidate.answer.uci)}</Button>{candidate.continuation.length > 0 &&
              <span className="tactical-target">{candidate.continuation.map(move => move.uci).join(" ")}</span>}</td>
          <td>{tacticalScore(scores.get(candidate.answer.uci) ?? null)}
            {detail.best_moves.some(move => move.uci === candidate.answer.uci) ? <span className="tactical-target">Best</span>
              : assessment.accepted_moves.some(move => move.uci === candidate.answer.uci) && <span className="tactical-target">Within 30 cp</span>}
            {candidate.answer.uci === assessment.played.uci && <span className="tactical-target">Played</span>}</td>
          <td>{candidate.attackers.map(piece => `${piece.role} ${piece.square}`).join(", ")}
            {candidate.targets.length > 0 && ` → ${candidate.targets.map(piece => `${piece.role} ${piece.square}`).join(", ")}`}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </article>;
}

export function PersonalTactics({dataset, onOpen, analysisProgress}) {
  const [filters, setFilters] = useState({});
  const [before, setBefore] = useState(undefined);
  const [detail, setDetail] = useState(undefined);
  const [position, setPosition] = useState(null);
  const [anchor, setAnchor] = useState(undefined);
  const [refresh, setRefresh] = useState(0);
  const [snapshot, setSnapshot] = useState(null);
  const [failedRequest, setFailedRequest] = useState(null);
  const readProgress = useEffectEvent(() => analysisProgress);
  const request = useMemo(() => ({dataset, filters, before, anchor, refresh}),
    [dataset, filters, before, anchor, refresh]);
  const view = snapshot?.request === request ? snapshot.value : null;
  const reportError = failedRequest === request;
  const filterOptions = snapshot?.request.dataset === dataset ? snapshot.value : null;

  useEffect(() => {
    const owner = new AbortController();
    const {dataset, filters, before, anchor} = request;
    const requestFilters = {...filters};
    if (filters.clock) {
      const [seconds, increment] = filters.clock.split(":").map(Number);
      requestFilters.clock = {seconds, increment};
    }
    for (const key of ["prior_today", "prior_hour"]) {
      const [min, max] = filters[key] ?? ["", ""];
      requestFilters[key] = min || max ? [min === "" ? 0 : Number(min), max === "" ? Number.MAX_SAFE_INTEGER : Number(max)] : undefined;
    }
    const pending = setTimeout(() => {
      const progressAtRead = readProgress();
      readPersonalTactics(dataset, {filters: requestFilters, before, anchor}, owner.signal).then(value => {
        if (!owner.signal.aborted) setSnapshot({request, value, progressAtRead});
      }).catch(() => { if (!owner.signal.aborted) setFailedRequest(request); });
    }, 120);
    return () => {clearTimeout(pending); owner.abort();};
  }, [request]);

  useEffect(() => {
    if (!view || detail === undefined) return;
    const owner = new AbortController();
    readPersonalPosition(dataset, detail, owner.signal).then(value => {
      if (!owner.signal.aborted) setPosition({view, detail, value});
    }).catch(() => { if (!owner.signal.aborted) setPosition({view, detail, error: true}); });
    return () => owner.abort();
  }, [dataset, detail, view]);

  function change(key, value) {
    setFilters(current => ({...current, [key]: value}));
    setBefore(undefined);
    setDetail(undefined);
  }
  const select = (key, label, options) => <Filter label={label} value={filters[key]} choices={options} change={value => change(key,value)}/>;
  const currentPosition = position?.view === view && position.detail === detail ? position : null;
  const displayed = detail === undefined ? view?.detail : currentPosition?.value;
  const selected = view?.games.find(row => row.id === displayed?.id);
  const bands = values => (values ?? []).map(min => [min, `${min}–${min + 49}`]);
  return <Surface>
    <h2>Personal tactics</h2>
    <p>Report snapshot. Refresh the report to see newer analysis.</p>
    <Button size="compact" variant="quiet" onClick={() => setRefresh(value => value + 1)}>Refresh report</Button>
    {view && snapshot.progressAtRead !== analysisProgress && <p role="status">Newer analysis may be available.</p>}
    <div className="tactical-filters">
      {select("motif", "Motif", Object.entries(motifNames))}
      {select("result", "Result", [["win","Win"],["draw","Draw"],["loss","Loss"],["unknown","Unknown"]])}
      {select("speed", "Speed", Object.entries(speedNames))}
      {select("clock", "Exact time control", (filterOptions?.clocks ?? []).map(clock => [`${clock.seconds}:${clock.increment}`, clockLabel(clock)]))}
      {select("source", "Site", (filterOptions?.sources ?? []).map(site => [site,sourceNames[site] ?? site]))}
      {select("learner_rating", "Your rating", bands(filterOptions?.learner_bands))}
      {select("opponent_rating", "Opponent rating", bands(filterOptions?.opponent_bands))}
      {select("weekday", "Weekday", weekdays.map((day,index) => [index,day]))}
      {select("start_hour", "Start hour (Eastern)", Array.from({length:24}, (_,hour) => [hour,`${String(hour).padStart(2,"0")}:00`]))}
      <LoadFilter label="Games earlier that day" value={filters.prior_today} change={value => change("prior_today",value)}/>
      <LoadFilter label="Games in preceding hour" value={filters.prior_hour} change={value => change("prior_hour",value)}/>
    </div>
    {reportError && <StatusNotice kind="error">Unable to read the personal tactics report.</StatusNotice>}
    {!view && !reportError && <p role="status">Reading your games…</p>}
    {anchor !== undefined && <Button onClick={() => {setAnchor(undefined); setBefore(undefined); setDetail(undefined);}}>Back to all opportunities</Button>}
    {before !== undefined && <Button onClick={() => {setBefore(undefined);setDetail(undefined);}}>Newest</Button>}
    {view && <>
      <LossComparison view={view}/>
      <h3>When to take a break</h3>
      <PlayingLoad title="Games earlier that day" pattern={view.prior_today}/>
      <PlayingLoad title="Games in the preceding hour" pattern={view.prior_hour}/>
      <h3>{anchor ? "Similar positions" : "Tactical opportunities"}</h3>
      <div className="tactical-history-layout">
        <ol>{view.games.map(row => <li key={row.id}><Button size="compact" variant="quiet" aria-pressed={selected?.id === row.id}
          onClick={() => setDetail(row.id)}>{row.motifs.map(motif => motifNames[motif]).join(" · ")} · {row.game.result}</Button></li>)}</ol>
        {selected && <Finding key={selected.id} row={selected} detail={displayed} dataset={dataset} onOpen={onOpen}
          onSimilar={id => {setAnchor(id); setBefore(undefined); setDetail(undefined);}}/>}
        {detail !== undefined && !currentPosition && <p role="status">Reading the selected position…</p>}
        {currentPosition?.error && <StatusNotice kind="error">Unable to read the selected position.</StatusNotice>}
      </div>
      {view.games.length === 0 && <p>No analyzed positions match these filters.</p>}
      {view.next_before !== null && <Button onClick={() => {setBefore(view.next_before);setDetail(undefined);}}>Older</Button>}
    </>}
  </Surface>;
}

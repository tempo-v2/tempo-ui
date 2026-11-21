import React, { useEffect, useMemo, useState } from "react";
import { Button, IconButton, StatusNotice } from "@tempo-v2/core-components";
import { NextIcon, PreviousIcon } from "./ControlIcons.jsx";
import { readGameLibraryPage } from "./game_commands.js";
import "./game_library.css";

const defaults = {query:"", book:"", reason:"", color:"", page:0};
const PAGE_SIZE = 15;
export const reasons = {
  opponent_gap:"Opponent played an unprepared move",
  learner_move:"I played a different move",
  authored_endpoint:"Prepared line ended",
  compatible:"In preparation throughout",
  outside_context:"Outside the repertoire’s opening",
  unavailable:"Repertoire source unavailable",
};

function reason(book) {
  return book.source_available ? book.first_departure?.kind ?? "compatible" : "unavailable";
}

export function recordedFinding(book, moves) {
  const departure = book.first_departure;
  const san = book.source_available && departure && moves[departure.ply - 1];
  return reasons[reason(book)] + (san ? " · " + san : departure && book.source_available ? " · half-move " + departure.ply : "");
}

function matchesQuery(game, input) {
  const query = input.trim().toLowerCase();
  if (!query) return true;
  const fields = [game.white + " vs " + game.black, game.opening, game.eco];
  if (fields.some(field => field?.toLowerCase().includes(query))) return true;
  const san = query.replace(/\b\d+\.(?:\.\.)?/g, " ").replace(/\s+/g, " ").trim();
  return !!san && (" " + game.moves.join(" ").toLowerCase() + " ").includes(" " + san + " ");
}

function savedFilters(key) {
  try { return {...defaults, ...JSON.parse(sessionStorage.getItem(key))}; }
  catch { return defaults; }
}

export function GameLibrary({dataset, refresh, books, recent, renderResults, renderRecent, empty}) {
  const storageKey = "tempo.game-library.v1." + dataset;
  const [filter, setFilter] = useState(() => savedFilters(storageKey));
  const [revision, setRevision] = useState(0);
  const [archive, setArchive] = useState({games:[], done:false, issue:""});
  useEffect(() => {
    const owner = new AbortController();
    async function load() {
      const games = [];
      let through, before;
      setArchive({games:[], done:false, issue:""});
      try {
        do {
          const reply = await readGameLibraryPage(dataset, through, before, owner.signal);
          if (owner.signal.aborted) return;
          through = reply.through;
          before = reply.next_before;
          games.push(...reply.entries);
          setArchive({games:[...games], done:before === null, issue:""});
        } while (before !== null);
      } catch (err) {
        if (!owner.signal.aborted) setArchive({games, done:false, issue:err.message});
      }
    }
    void load();
    return () => owner.abort();
  }, [dataset, refresh, revision]);
  const update = change => {
    const next = {...filter, page:0, ...change};
    setFilter(next);
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Browsing still works. */ }
  };
  const groups = useMemo(() => {
    const recentRows = new Map();
    for (const row of recent ?? []) {
      const key = JSON.stringify([row.source,row.game_id,row.learner]);
      if (!recentRows.has(key)) recentRows.set(key, []);
      recentRows.get(key).push(row);
    }
    const results = [];
    for (const game of archive.games) {
      if (filter.color && game.color !== filter.color || !matchesQuery(game, filter.query)) continue;
      const comparisons = game.repertoires.filter(book =>
        (!filter.book || filter.book === book.repertoire_id) && (!filter.reason || reason(book) === filter.reason));
      if ((filter.reason || filter.book) && !comparisons.length) continue;
      const key = JSON.stringify([game.source,game.game_id,game.learner]);
      results.push({key, game, rows:recentRows.get(key) ?? [], comparisons,
        destination:filter.book || (comparisons.length === 1 ? comparisons[0].repertoire_id : null)});
    }
    return results.sort((a,b) => (b.game.played_ms ?? -1) - (a.game.played_ms ?? -1));
  }, [archive.games, recent, filter.color, filter.query, filter.book, filter.reason]);
  const recentOnly = useMemo(() => {
    if (!(archive.done || archive.issue) || !recent?.length) return [];
    const keys = new Set(archive.games.map(g => JSON.stringify([g.source,g.game_id,g.learner])));
    return recent.filter(g => !keys.has(JSON.stringify([g.source,g.game_id,g.learner])));
  }, [recent,archive]);
  const active = !!(filter.query || filter.color || filter.book || filter.reason);
  const page = Math.min(filter.page, Math.max(0, Math.ceil(groups.length/PAGE_SIZE)-1));
  const offset = page * PAGE_SIZE;
  const selectedBook = filter.book && books.find(book => book.id === filter.book);
  return <>
    <div className="library-controls">
      <div><label htmlFor="archive-query">Find a game</label><input id="archive-query" type="search" placeholder="Opening, player or moves" value={filter.query} onChange={e=>update({query:e.target.value})} /></div>
      <div><label htmlFor="archive-book">Repertoire</label><select id="archive-book" value={filter.book} onChange={e=>update({book:e.target.value})}>
        <option value="">All repertoires</option>{books.map(book=><option key={book.id} value={book.id}>{book.name}</option>)}</select></div>
      <div><label htmlFor="archive-reason">First decision at import</label><select id="archive-reason" value={filter.reason} onChange={e=>update({reason:e.target.value})}>
        <option value="">Any decision</option>{Object.entries(reasons).map(([key,text])=><option key={key} value={key}>{text}</option>)}</select></div>
      <div><label htmlFor="archive-color">I played</label><select id="archive-color" value={filter.color} onChange={e=>update({color:e.target.value})}>
        <option value="">Either color</option><option value="white">White</option><option value="black">Black</option></select></div>
    </div>
    <p className="library-note">Search by the opening named in the PGN or a sequence from its first 12 half-moves. Decisions come from the latest recorded comparison.</p>
    {archive.issue && <StatusNotice kind="error">{archive.issue} <Button size="compact" onClick={()=>setRevision(n=>n+1)}>Retry library</Button></StatusNotice>}
    <div className="library-summary"><strong role="status">{archive.done ? groups.length.toLocaleString() + (groups.length === 1 ? " game" : " games") : "Reading game library…"}
      {active && archive.done && " of " + archive.games.length.toLocaleString()}</strong>
      {active && <Button size="compact" variant="quiet" onClick={()=>update(defaults)}>Clear filters</Button>}</div>
    {groups.length ? renderResults(groups.slice(offset,offset+PAGE_SIZE), !!(filter.book || filter.reason)) :
      archive.done && (active ? <div className="empty-games"><h3>No games match these filters.</h3>
        <p>{selectedBook && filter.reason ? "Try another opening decision for "+selectedBook.name+" or clear the opening search." : "Try a player, fewer opening moves or a different decision."}</p></div> : !recentOnly.length && empty)}
    {!active && recentOnly.length > 0 && <details><summary>Recent comparisons outside this library read</summary>{renderRecent(recentOnly)}</details>}
    {groups.length > PAGE_SIZE && <nav className="library-pages" aria-label="Game pages">
      <IconButton label="Previous games" disabled={page === 0}
        onClick={() => update({page:page-1})}><PreviousIcon /></IconButton>
      <span>{offset+1}–{Math.min(offset+PAGE_SIZE,groups.length)} of {groups.length.toLocaleString()}</span>
      <IconButton label="Next games" disabled={offset+PAGE_SIZE>=groups.length}
        onClick={() => update({page:page+1})}><NextIcon /></IconButton></nav>}
  </>;
}

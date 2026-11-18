import React, { useEffect, useRef, useState } from "react";
import { Board, Button, PageHeader, StatusNotice, Surface } from "@tempo-v2/core-components";
import { MoveTrail } from "./MoveTrail.jsx";
import { postCommand } from "./content_transport.js";
import { studyChangeKey, studyChangeStamp } from "./study_presence.js";
import { turnFromFen } from "./StudyBoard.jsx";

const endpoint = "/api/tactics-collection";

function Source({ text }) {
  try {
    const url = new URL(text.replace(/^Site: /, ""));
    if (url.protocol === "https:" || url.protocol === "http:")
      return <a href={url.href} target="_blank" rel="noopener noreferrer">{text}</a>;
  } catch {}
  return text;
}

export function TacticsCollectionPage({ onStudy, onCapture, onSettings }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState({ search: "", filter: "all", cursors: [null] });
  const [page, setPage] = useState(null);
  const [target, setTarget] = useState(null);
  const [detail, setDetail] = useState(null);
  const [index, setIndex] = useState(0);
  const [issue, setIssue] = useState("");
  const detailRequest = useRef(0);

  useEffect(() => {
    let current = true;
    setPage(null);
    setIssue("");
    postCommand(endpoint, {
      command: "list", search: query.search, filter: query.filter, after: query.cursors.at(-1),
    }).then(reply => {
      if (!current) return;
      if (reply.status !== "tactics_page") setIssue(reply.message ?? "Could not load tactics.");
      else setPage(reply);
    }).catch(() => { if (current) setIssue("Could not load tactics."); });
    return () => { current = false; };
  }, [query]);

  useEffect(() => {
    if (!target || !page) return;
    loadDetail(false);
    function invalidate(event) {
      if (event.type === "storage" && event.key !== studyChangeKey) return;
      ++detailRequest.current;
      setDetail(null);
      if (!document.hidden && event.type !== "storage") loadDetail(false);
      // Study may be in flight elsewhere. Require a fresh detail click.
      if (event.type === "storage") setTarget(null);
    }
    window.addEventListener("storage", invalidate);
    window.addEventListener("pageshow", invalidate);
    document.addEventListener("visibilitychange", invalidate);
    return () => {
      ++detailRequest.current;
      window.removeEventListener("storage", invalidate);
      window.removeEventListener("pageshow", invalidate);
      document.removeEventListener("visibilitychange", invalidate);
    };
  }, [target, page]);

  async function loadDetail(showSolution) {
    const request = ++detailRequest.current;
    const before = studyChangeStamp();
    setIssue("");
    try {
      const reply = await postCommand(endpoint, {
        command: "detail", dataset_id: page.dataset_id, target, show_solution: showSolution,
      });
      if (request !== detailRequest.current || (showSolution && studyChangeStamp() !== before)) return;
      if (reply.status !== "tactic_detail") setIssue(reply.message ?? "Could not load this tactic.");
      else {
        setIndex(0);
        setDetail(reply);
      }
    } catch {
      if (request === detailRequest.current) setIssue("Could not load this tactic.");
    }
  }

  function changeTarget(next) {
    ++detailRequest.current;
    setDetail(null);
    setTarget(next);
  }

  const fen = detail?.solution?.moves[index - 1]?.fen ?? detail?.fen;
  return (
    <main className="tempo-core repertoire-page tactic-collection">
      <PageHeader title="Tactics" actions={<div className="actions">
        <Button onClick={onStudy}>Study</Button>
        <Button onClick={onCapture}>Capture tactics</Button>
        <Button onClick={onSettings}>Tactics settings</Button>
      </div>} />
      {issue && <StatusNotice kind="error">{issue}</StatusNotice>}
      {target ? (
        <Surface>
          <Button onClick={() => changeTarget(null)}>Back to tactics</Button>
          {detail ? <>
            <h2>{detail.label}</h2>
            <div className="capture-board">
              <Board fen={fen} orientation={detail.learner_color} turn={turnFromFen(fen)}
                mode="select" readOnly positionIdentity={`${target}:${index}`}
                positionRevision={0} ariaLabel="Tactic position" />
            </div>
            <h3>Sources</h3>
            {detail.provenance.length
              ? <ul>{detail.provenance.map((text, i) => <li key={i}><Source text={text} /></li>)}</ul>
              : <p>No source recorded.</p>}
            {detail.availability !== "active" && <p>Unavailable in Study.</p>}
            {detail.solution_blocked ? (
              <>
                <p>This tactic is open in Study. Return there to continue or use the available move help.</p>
                <Button onClick={onStudy}>Return to Study</Button>
              </>
            ) : detail.solution
              ? <MoveTrail line={detail.solution} index={index} onInspect={setIndex} />
              : <Button onClick={() => loadDetail(true)}>Show solution</Button>}
          </> : !issue && <p role="status">Loading tactic…</p>}
        </Surface>
      ) : (
        <Surface>
          <form className="repertoire-form" onSubmit={event => {
            event.preventDefault();
            setQuery({ search, filter, cursors: [null] });
          }}>
            <label>Search labels and sources <input type="search" value={search} maxLength={120}
              onChange={event => setSearch(event.target.value)} /></label>
            <label>Learning status <select value={filter} onChange={event => setFilter(event.target.value)}>
              <option value="all">All tactics</option>
              <option value="introduced">Introduced</option>
              <option value="unintroduced">Unintroduced</option>
              <option value="due">Due</option>
            </select></label>
            <Button type="submit">Search</Button>
          </form>
          {page?.rows.length ? (
            <ul className="tactic-results">
              {page.rows.map(row => <li key={row.target}>
                <Button onClick={() => changeTarget(row.target)}>{row.label}</Button>
                <span>{row.due ? "Due" : row.introduced ? "Introduced" : "Unintroduced"}</span>
              </li>)}
            </ul>
          ) : <p role="status">{page ? "No tactics match this search." : issue ? "" : "Loading tactics…"}</p>}
          <div className="actions">
            <Button disabled={!page || query.cursors.length < 2} onClick={() =>
              setQuery({ ...query, cursors: query.cursors.slice(0, -1) })}>Previous page</Button>
            <span>Page {query.cursors.length}</span>
            <Button disabled={!page?.next} onClick={() =>
              setQuery({ ...query, cursors: [...query.cursors, page.next] })}>Next page</Button>
          </div>
        </Surface>
      )}
    </main>
  );
}

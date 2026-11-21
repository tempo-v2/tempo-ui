import React, { useEffect, useState } from "react";
import { Button, StatusNotice } from "@tempo-v2/core-components";
import { validateCardDetails } from "./card_details.js";
import { studyChangeKey, studyChangeStamp } from "./study_presence.js";
import { readReviewCommand } from "./saved_review_commands.js";

function webLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch {}
  return null;
}

export function CardDetailsContent({ details }) {
  const full = details.explanation;
  const game = full?.game;
  const gameUrl = webLink(game?.url);
  const links = (full?.links ?? []).map(webLink).filter(Boolean);
  return <div>
    <p>{details.kind === "tactic" ? "Tactic" : "Opening card"} · {details.sources.join(" · ")}</p>
    {full?.title && <p>{full.title}</p>}
    {full?.capture_method.length > 0 && <p>{full.capture_method.join(" · ")}</p>}
    {game && <p>{game.white} vs. {game.black} · Half-move {game.half_move}
      {game.finding && <> · {game.finding}</>}
      {gameUrl && <> · <a href={gameUrl} target="_blank" rel="noopener noreferrer">Open game</a></>}
    </p>}
    {links.map((url, index) => <p key={url}>
      <a href={url} target="_blank" rel="noopener noreferrer">
        {links.length === 1 ? "Open capture source" : `Open capture source ${index + 1}`}
      </a>
    </p>)}
    {full?.themes.length > 0 && <p>Imported themes · {full.themes.join(", ")}</p>}
    {full && details.kind === "tactic" && !game?.finding && full.themes.length === 0 &&
      <p>Tempo has no recorded reason this position was considered tactical.</p>}
  </div>;
}

export function StudyCardDetails({ view, onOpen }) {
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState(null);
  const [retry, setRetry] = useState(0);
  const { dataset_id, attempt_id, revision, content_version } = view;
  useEffect(() => {
    if (!open) return;
    const owner = new AbortController();
    const address = { dataset_id, attempt_id, revision, content_version };
    const stamp = studyChangeStamp();
    function closeDetails() {
      owner.abort();
      setRead(null);
      setOpen(false);
    }
    function closeOnStudyChange(event) {
      if (event.key === studyChangeKey) closeDetails();
    }
    window.addEventListener("storage", closeOnStudyChange);
    window.addEventListener("pageshow", closeDetails);
    window.addEventListener("blur", closeDetails);
    window.addEventListener("focus", closeDetails);
    document.addEventListener("visibilitychange", closeDetails);
    readReviewCommand("/api/study/card-details", address, owner.signal).then(reply => {
      if (reply?.status !== "card_details" || !reply.details ||
          !Object.entries(address).every(([field, value]) => reply[field] === value)) {
        throw new Error("Tempo could not verify the card details.");
      }
      const details = validateCardDetails(reply.details);
      if (owner.signal.aborted) return;
      if (studyChangeStamp() !== stamp) {
        setOpen(false);
        return;
      }
      setRead({ details });
    }).catch(error => {
      if (!owner.signal.aborted) setRead({ error: error.message });
    });
    return () => {
      owner.abort();
      window.removeEventListener("storage", closeOnStudyChange);
      window.removeEventListener("pageshow", closeDetails);
      window.removeEventListener("blur", closeDetails);
      window.removeEventListener("focus", closeDetails);
      document.removeEventListener("visibilitychange", closeDetails);
    };
  }, [dataset_id, attempt_id, revision, content_version, open, retry]);
  return <>
    <Button size="compact" aria-expanded={open} onClick={() => {
      if (!open) {
        setRead(null);
        onOpen();
      }
      setOpen(!open);
    }}>Card details</Button>
    {open && (read?.details ? <CardDetailsContent details={read.details} /> : read?.error
      ? <><StatusNotice kind="error">{read.error}</StatusNotice>
        <Button size="compact" onClick={() => { setRead(null); setRetry(value => value + 1); }}>Retry details</Button></>
      : <p role="status">Loading card details…</p>)}
  </>;
}

import React, { useCallback, useEffect, useId, useState } from "react";
import { Button, IconButton, StatusNotice } from "@tempo-v2/core-components";
import { InfoIcon } from "./ControlIcons.jsx";
import { CARD_DISCLOSURE_RECHECK_MS, validateCardDetails } from "./card_details.js";
import { studyChangeKey, studyChangeStamp } from "./study_presence.js";
import { readReviewCommand, savedReviewsPath } from "./saved_review_commands.js";

function webLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch {}
  return null;
}

function CardDetailsContent({ details }) {
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

export function StudyCardDetails({ view, onOpen, renderActions }) {
  const { dataset_id, attempt_id, revision, content_version } = view;
  const load = useCallback(async signal => {
    const address = { dataset_id, attempt_id, revision, content_version };
    const reply = await readReviewCommand("/api/study/card-details", address, signal);
    if (reply?.status !== "card_details" ||
        !Object.entries(address).every(([field, value]) => reply[field] === value)) {
      throw new Error("Tempo could not verify the card details.");
    }
    return validateCardDetails(reply.details);
  }, [dataset_id, attempt_id, revision, content_version]);
  return <CardDetailsPanel load={load} onOpen={onOpen} recheckExplanation renderActions={renderActions} />;
}

export function SavedReviewCardDetails({ datasetId, id, onDisclosureChanged }) {
  const load = useCallback(async signal => {
    const reply = await readReviewCommand(savedReviewsPath, {
      command: "card_details", dataset_id: datasetId, id,
    }, signal);
    if (reply?.id === id && reply.status === "study_required") {
      if (!signal.aborted) onDisclosureChanged();
      throw new Error("Finish in Study to open card details.");
    }
    if (reply?.id !== id || reply.status !== "card_details") {
      throw new Error("Tempo could not verify the card details.");
    }
    return validateCardDetails(reply.details);
  }, [datasetId, id, onDisclosureChanged]);
  return <CardDetailsPanel load={load} />;
}

function CardDetailsPanel({ load, onOpen, recheckExplanation, renderActions }) {
  const detailsId = useId();
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    const owner = new AbortController();
    const stamp = studyChangeStamp();
    let timer;
    function closeDetails() {
      owner.abort();
      clearTimeout(timer);
      setRead(null);
      setOpen(false);
    }
    function closeOnStudyChange(event) {
      if (event.key === studyChangeKey) closeDetails();
    }
    async function readDetails() {
      try {
        const details = await load(owner.signal);
        if (owner.signal.aborted) return;
        if (studyChangeStamp() !== stamp) {
          closeDetails();
          return;
        }
        setRead({ details });
        if (recheckExplanation && details.explanation) {
          timer = setTimeout(readDetails, CARD_DISCLOSURE_RECHECK_MS);
        }
      } catch (error) {
        if (!owner.signal.aborted) setRead({ error: error.message });
      }
    }
    window.addEventListener("storage", closeOnStudyChange);
    window.addEventListener("pageshow", closeDetails);
    window.addEventListener("blur", closeDetails);
    window.addEventListener("focus", closeDetails);
    document.addEventListener("visibilitychange", closeDetails);
    void readDetails();
    return () => {
      owner.abort();
      clearTimeout(timer);
      window.removeEventListener("storage", closeOnStudyChange);
      window.removeEventListener("pageshow", closeDetails);
      window.removeEventListener("blur", closeDetails);
      window.removeEventListener("focus", closeDetails);
      document.removeEventListener("visibilitychange", closeDetails);
    };
  }, [load, open, recheckExplanation, retry]);
  const trigger = (
    <IconButton label="Card details" aria-controls={detailsId} aria-expanded={open} onClick={() => {
      if (!open) {
        setRead(null);
        onOpen?.();
      }
      setOpen(!open);
    }}><InfoIcon /></IconButton>
  );
  return <>
    {renderActions ? renderActions(trigger) : trigger}
    <div id={detailsId} hidden={!open}>
      {open && (read?.details ? <CardDetailsContent details={read.details} /> : read?.error
        ? <><StatusNotice kind="error">{read.error}</StatusNotice>
          <Button size="compact" onClick={() => { setRead(null); setRetry(value => value + 1); }}>Retry details</Button></>
        : <p role="status">Loading card details…</p>)}
    </div>
  </>;
}

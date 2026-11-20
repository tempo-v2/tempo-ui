import { useEffect, useState } from "react";
import { Chess } from "chess.js";
import { readVisit, rememberVisit } from "./review_route.js";
import { playBoardMove } from "./board_move.js";

function draftKey(address) {
  return "tempo.game-draft.v1." + JSON.stringify([address.dataset_id,address.source,address.game_id,address.learner]);
}

export function hasReviewDraft(address) {
  try { return localStorage.getItem(draftKey(address)) !== null; }
  catch { return false; }
}

// Pairs the tab's signed-command recovery record with its specific game draft.
function saveKey(command) {
  return "tempo.game-draft-save.v1." + JSON.stringify([command.dataset_id,command.repertoire_id,command.token]);
}

export function draftSaveBinding(command) {
  return JSON.parse(sessionStorage.getItem(saveKey(command)) || "null");
}

export function settleReviewDraftSave(command,accepted) {
  const binding = draftSaveBinding(command);
  if (!binding) return;
  if (accepted) {
    const key = draftKey(binding.address);
    if (localStorage.getItem(key) === binding.version) localStorage.removeItem(key);
    const last = readVisit(binding.address);
    rememberVisit(last?.address ?? binding.address, {saved:{endpoint:binding.endpoint,
      repertoire_id:command.repertoire_id,name:command.name,at:Date.now()}});
  }
  sessionStorage.removeItem(saveKey(command));
}

function read(key, positions) {
  let raw;
  try {
    raw = localStorage.getItem(key);
    if (raw === null) return {raw, line:null};
    const value = JSON.parse(raw);
    const {start, ply, branch, startFen, played} = value;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(ply) || start < 0 ||
        start > ply || ply >= positions.length || !Array.isArray(branch) ||
        startFen !== positions[start].fen ||
        JSON.stringify(played) !== JSON.stringify(positions.slice(start,ply).map(p=>p.played_uci))) {
      throw new Error();
    }
    const board = new Chess(positions[ply].fen);
    for (const move of branch) playBoardMove(board, move);
    return {raw, line:{start,ply,branch}};
  } catch {
    return {raw,line:null,error:"The retained draft could not be opened for this game."};
  }
}

// Draft owns the user's chosen range and continuation. Destination is chosen at preview.
export function useReviewDraft(address,positions,onChangedElsewhere) {
  const key = draftKey(address);
  const [stored,setStored] = useState(()=>read(key,positions));
  useEffect(()=>{
    function storage(e) {
      if (e.storageArea === localStorage && (e.key === key || e.key === null)) {
        setStored(read(key,positions));
        onChangedElsewhere();
      }
    }
    window.addEventListener("storage",storage);
    return ()=>window.removeEventListener("storage",storage);
  },[key,positions,onChangedElsewhere]);
  function write(line) {
    // Preserve another tab's later edit if its storage notification is still queued.
    if (localStorage.getItem(key) !== stored.raw) {
      setStored(read(key,positions));
      throw new Error("This draft changed in another tab. Review its current line first.");
    }
    if (line && stored.error) throw new Error(stored.error);
    const raw = line ? JSON.stringify({...line,edit_id:crypto.randomUUID(),startFen:positions[line.start].fen,
      played:positions.slice(line.start,line.ply).map(p=>p.played_uci)}) : null;
    if (raw === null) localStorage.removeItem(key);
    else localStorage.setItem(key,raw);
    setStored({raw,line});
    return raw;
  }
  const isCurrent = version => localStorage.getItem(key) === version;
  function bindSave(command,version,endpoint,cursor,selection) {
    if (version === null || !isCurrent(version)) throw new Error("The draft changed. Preview the current line first.");
    sessionStorage.setItem(saveKey(command),JSON.stringify({address:{...address,...cursor},version,endpoint,selection}));
  }
  return {draft:stored.line,draftError:stored.error,version:stored.raw,
    write,isCurrent,bindSave,refresh:()=>setStored(read(key,positions))};

}

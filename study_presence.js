// A visible collection drops disclosed moves when another tab requests study.
export const studyChangeKey = "tempo-v2-study-activity";

export function studyChangeStamp() {
  try { return window.localStorage.getItem(studyChangeKey); } catch { return null; }
}

export function signalStudyChange() {
  try { window.localStorage.setItem(studyChangeKey, crypto.randomUUID()); } catch {}
}

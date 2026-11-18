import React from "react";

export function celebratesTactic(view) {
  return view?.status === "complete" && view.activity === "test" &&
    !view.repertoire_name && view.assessment === "good";
}

export function StudyOutcome({ view }) {
  if (view?.status !== "complete") return null;
  if (view.activity === "teach")
    return <p role="status">Lesson saved. Your first review was scheduled for the next study day.</p>;
  if (view.activity === "practice") {
    return <p role="status">{view.assessment === "again"
      ? "Practice completed after correction. Schedule unchanged."
      : "Practice complete. Schedule unchanged."}</p>;
  }
  return <p role="status">{view.assessment === "again"
    ? "Completed after correction. Review recorded as Again."
    : "Review recorded as Good."}</p>;
}

import React from "react";
import { App } from "./App.jsx";
import { StudyAnalysisEntry } from "./StudyAnalysisEntry.jsx";
import { GamesPage } from "./GamesPage.jsx";
import { SavedReviewsPage } from "./SavedReviewsPage.jsx";
import { RepertoiresPage } from "./RepertoiresPage.jsx";
import { hasPendingRepertoireCommand } from "./repertoire_commands.js";
import { readGapContinuation } from "./gap_save.js";
import { TacticsCollectionPage } from "./TacticsCollectionPage.jsx";
import { TacticSettingsPage } from "./TacticSettingsPage.jsx";
import { TacticsCapturePage } from "./TacticsCapturePage.jsx";
import { hasPendingTacticCommand } from "./tactic_commands.js";

function initialPage() {
  if (readGapContinuation()) return "games";
  if (hasPendingRepertoireCommand()) return "repertoires";
  if (hasPendingTacticCommand()) return "capture";
  return "study";
}

function renderSection(page, goTo, datasetId) {
  const onStudy = () => goTo("study");
  if (page === "saved-reviews") return <SavedReviewsPage datasetId={datasetId} onStudy={onStudy} />;
  if (page === "games") return <GamesPage onStudy={onStudy}
    onRepertoires={() => goTo("repertoires")} />;
  if (page === "repertoires") return <RepertoiresPage onStudy={onStudy} />;
  if (page === "tactics") return <TacticsCollectionPage onStudy={onStudy}
    onCapture={() => goTo("capture")} onSettings={() => goTo("tactic-settings")} />;
  if (page === "tactic-settings") return <TacticSettingsPage onStudy={onStudy} />;
  if (page === "capture") return <TacticsCapturePage datasetId={datasetId} onStudy={onStudy}
    onTactics={() => goTo("tactics")} />;
}

function renderAnalysis(visit, issue, onClose) {
  return <StudyAnalysisEntry visit={visit} issue={issue} onClose={onClose} />;
}

export function DesktopApp() {
  return <App initialPage={initialPage} renderSection={renderSection} renderAnalysis={renderAnalysis} />;
}

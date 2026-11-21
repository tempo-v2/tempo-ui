import React from "react";
import { App } from "./App.jsx";
import { DesktopBoardLayout } from "./MainBoard.jsx";
import { DesktopNavigation } from "./DesktopNavigation.jsx";
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
  return /^#games(?:\?|$)/.test(window.location.hash) ? "games" : "study";
}

function navigateSection(page, previous, href = "#games") {
  if (page === "games") {
    // A mounted Games page already handles fragment changes, including game-review return.
    if (previous === "games") {
      window.location.hash = href;
      return;
    }
    window.history.pushState(null, "", href);
  } else if (location.hash.startsWith("#games")) {
    window.history.pushState(null, "", location.pathname + location.search);
  }
  document.documentElement.scrollTop = 0;
}

function subscribeNavigation(page, changePage) {
  let currentPage = page;
  function syncPage() {
    if (hasPendingRepertoireCommand() || hasPendingTacticCommand()) return;
    const nextPage = /^#games(?:\?|$)/.test(location.hash) ? "games"
      : currentPage === "games" ? "study" : currentPage;
    if (nextPage === currentPage) return;
    currentPage = nextPage;
    changePage(nextPage);
  }
  window.addEventListener("popstate", syncPage);
  window.addEventListener("hashchange", syncPage);
  return () => {
    window.removeEventListener("popstate", syncPage);
    window.removeEventListener("hashchange", syncPage);
  };
}

function renderSection(page, goTo, datasetId, onTacticExcluded) {
  const onStudy = () => goTo("study");
  if (page === "saved-reviews") return <SavedReviewsPage datasetId={datasetId} onStudy={onStudy}
    onTacticExcluded={onTacticExcluded} />;
  if (page === "games") return <GamesPage onStudy={onStudy}
    onRepertoires={() => goTo("repertoires")} />;
  if (page === "repertoires") return <RepertoiresPage onStudy={onStudy} />;
  if (page === "tactics") return <TacticsCollectionPage onStudy={onStudy}
    onCapture={() => goTo("capture")} onSettings={() => goTo("tactic-settings")} />;
  if (page === "tactic-settings") return <TacticSettingsPage onStudy={onStudy} />;
  if (page === "capture") return <TacticsCapturePage datasetId={datasetId} onStudy={onStudy}
    onTactics={() => goTo("tactics")} />;
}

function renderAnalysis(visit, issue, onClose, launch) {
  return <StudyAnalysisEntry visit={visit} issue={issue} onClose={onClose} launch={launch} />;
}

function renderNavigation(page, onNavigate, navigationLocked) {
  return <DesktopNavigation page={page} onNavigate={onNavigate} navigationLocked={navigationLocked} />;
}

export function DesktopApp() {
  return <div className="tempo-desktop">
    <DesktopBoardLayout>
      <App studyPresenceSurface="desktop" initialPage={initialPage} renderSection={renderSection} renderAnalysis={renderAnalysis}
        navigateSection={navigateSection} subscribeNavigation={subscribeNavigation} renderNavigation={renderNavigation} />
    </DesktopBoardLayout>
  </div>;
}

import React from "react";
import { App } from "./App.jsx";
import { DesktopBoardLayout } from "./MainBoard.jsx";
import { DesktopNavigation } from "./DesktopNavigation.jsx";
import { GamesPage } from "./GamesPage.jsx";
import { SavedReviewsPage } from "./SavedReviewsPage.jsx";
import { RepertoiresPage } from "./RepertoiresPage.jsx";
import { hasPendingRepertoireCommand } from "./repertoire_commands.js";
import { readGapContinuation } from "./gap_save.js";
import { TacticsCollectionPage } from "./TacticsCollectionPage.jsx";
import { CoverageSettingsPage } from "./CoverageSettingsPage.jsx";
import { TacticSettingsPage } from "./TacticSettingsPage.jsx";
import { TacticsCapturePage } from "./TacticsCapturePage.jsx";
import { hasPendingTacticCommand } from "./tactic_commands.js";
import { initializeDesktopHistory, notifyGamesHistory, pushDesktopEntry, subscribeDesktopHistory } from "./desktop_history.js";

function initialPage() {
  initializeDesktopHistory();
  if (readGapContinuation()) return "games";
  if (hasPendingRepertoireCommand()) return "repertoires";
  if (hasPendingTacticCommand()) return "capture";
  return /^#games(?:\?|$)/.test(window.location.hash) ? "games" : "study";
}

function navigateSection(page, previous, href = "#games") {
  if (page === "games") {
    pushDesktopEntry(null, href);
    if (previous === "games") notifyGamesHistory();
  } else if (location.hash.startsWith("#games")) {
    pushDesktopEntry(null, location.pathname + location.search);
  }
  document.documentElement.scrollTop = 0;
}

function subscribeNavigation(page, changePage) {
  let currentPage = page;
  return subscribeDesktopHistory(() => {
    if (hasPendingRepertoireCommand() || hasPendingTacticCommand()) return false;
    const toGames = /^#games(?:\?|$)/.test(location.hash);
    const nextPage = toGames ? "games"
      : currentPage === "games" ? "study" : currentPage;
    if ((nextPage !== currentPage || toGames) && !changePage(nextPage)) return false;
    currentPage = nextPage;
    return true;
  });
}

function renderSection(page, goTo, datasetId, onTacticExcluded) {
  const onStudy = () => goTo("study");
  if (page === "saved-reviews") return <SavedReviewsPage datasetId={datasetId} onStudy={onStudy}
    onTacticExcluded={onTacticExcluded} />;
  if (page === "games") return <GamesPage onStudy={onStudy}
    onRepertoires={() => goTo("repertoires")} />;
  if (page === "coverage-settings") return <CoverageSettingsPage onStudy={onStudy} />;
  if (page === "repertoires") return <RepertoiresPage onStudy={onStudy} />;
  if (page === "tactics") return <TacticsCollectionPage onStudy={onStudy}
    onCapture={() => goTo("capture")} onSettings={() => goTo("tactic-settings")} />;
  if (page === "tactic-settings") return <TacticSettingsPage onStudy={onStudy} />;
  if (page === "capture") return <TacticsCapturePage onStudy={onStudy}
    onTactics={() => goTo("tactics")} />;
}

function renderNavigation(page, onNavigate, navigationLocked) {
  return <DesktopNavigation page={page} onNavigate={onNavigate} navigationLocked={navigationLocked} />;
}

export function DesktopApp() {
  return <div className="tempo-desktop">
    <DesktopBoardLayout>
      <App initialPage={initialPage} renderSection={renderSection}
        navigateSection={navigateSection} subscribeNavigation={subscribeNavigation} renderNavigation={renderNavigation}
        studyCompanionSection="saved-reviews" showOriginalGameLink />
    </DesktopBoardLayout>
  </div>;
}

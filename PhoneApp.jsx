import React from "react";
import { App, hasPendingStudyCommand } from "./App.jsx";
import { PhoneBuildPage } from "./PhoneBuildPage.jsx";
import { readGapContinuation } from "./gap_save.js";
import { phoneStudyTransport } from "./phone_study_transport.js";

function initialPage() {
  if (hasPendingStudyCommand()) return "study";
  return readGapContinuation() || location.hash === "#build" ? "build" : "study";
}

function navigateSection(page) {
  history.replaceState(null, "", page === "build" ? "#build" : location.pathname + location.search);
  document.documentElement.scrollTop = 0;
}

function renderSection(page) {
  if (page === "build") return <PhoneBuildPage />;
}

function renderNavigation(page, navigate, navigationLocked) {
  return <nav className="phone-nav" aria-label="Tempo phone sections">
    {["study", "build"].map(section => (
      <button key={section} type="button" aria-current={section === page ? "page" : undefined}
        disabled={section !== page && navigationLocked(section)} onClick={() => navigate(section)}>
        {section === "study" ? "Study" : "Build"}
      </button>
    ))}
  </nav>;
}

export function PhoneApp() {
  return <App studyPresenceSurface="phone" transport={phoneStudyTransport} boardContinuation
    initialPage={initialPage} renderSection={renderSection} renderNavigation={renderNavigation}
    navigateSection={navigateSection} />;
}

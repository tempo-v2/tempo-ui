export const moveStepShortcuts = {
  previous: { key: "ArrowLeft", label: "←" },
  next: { key: "ArrowRight", label: "→" },
};

export const studyShortcuts = {
  primary: { key: "Enter", label: "Enter" },
  flip: { key: "F", label: "F" },
  help: { key: "?", label: "?" },
  replay: {
    beginning: { key: "Home", label: "Home" },
    ...moveStepShortcuts,
    end: { key: "End", label: "End" },
    returnToPosition: { key: "R", label: "R" },
  },
};

export const closeDialogShortcut = { key: "Escape", label: "Escape" };

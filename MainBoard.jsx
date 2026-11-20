import React, { createContext, forwardRef, useContext, useSyncExternalStore } from "react";
import { Board } from "@tempo-v2/core-components";

const desktopBoardQuery = "(min-width: 52rem) and (pointer: fine) and (hover: hover)";
const ResizeEnabled = createContext(false);

function subscribe(listener) {
  const query = window.matchMedia?.(desktopBoardQuery);
  query?.addEventListener("change", listener);
  return () => query?.removeEventListener("change", listener);
}

function canResizeDesktopBoard() {
  return window.matchMedia?.(desktopBoardQuery).matches ?? false;
}

export function DesktopBoardLayout({ children }) {
  const canResize = useSyncExternalStore(subscribe, canResizeDesktopBoard, () => false);
  return <ResizeEnabled.Provider value={canResize}>
    <div className={canResize ? "desktop-board-resize" : undefined}>{children}</div>
  </ResizeEnabled.Provider>;
}

export const MainBoard = forwardRef(function MainBoard(props, ref) {
  const canResize = useContext(ResizeEnabled);
  return <Board {...props} ref={ref} resizeMode={canResize ? "drag" : undefined} />;
});

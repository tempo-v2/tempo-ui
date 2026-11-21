import { createContext, useContext, useLayoutEffect } from "react";

export const PageExitGuardContext = createContext(null);

// The page supplies its existing save lock and any draft confirmation to the desktop shell.
export function usePageExitGuard(locked, confirmExit) {
  const registerExitGuard = useContext(PageExitGuardContext);
  useLayoutEffect(() => registerExitGuard?.({ locked, confirmExit }), [registerExitGuard, locked, confirmExit]);
}

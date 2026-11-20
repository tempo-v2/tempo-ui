import React, { useState } from "react";
import { Button } from "@tempo-v2/core-components";
import { downloadDiagnostics } from "./diagnostics.js";

export function DiagnosticsButton() {
  const [failed, setFailed] = useState(false);
  return <>
    <Button size="compact" variant="quiet" onClick={() => setFailed(!downloadDiagnostics())}>
      Download diagnostics
    </Button>
    {failed && <span role="status">The browser could not download diagnostics.</span>}
  </>;
}

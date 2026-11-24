import React from "react";
import { App } from "./App.jsx";
import { phoneStudyTransport } from "./phone_study_transport.js";

export function PhoneApp() {
  return <App transport={phoneStudyTransport} boardContinuation />;
}

import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "@tempo-v2/core-components/styles.css";
import "./style.css";
createRoot(document.getElementById("root")).render(<App />);

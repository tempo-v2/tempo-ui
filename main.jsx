import React from "react";
import { createRoot } from "react-dom/client";
import { DesktopApp } from "./DesktopApp.jsx";
import "@tempo-v2/core-components/styles.css";
import "./style.css";
import "./desktop_navigation.css";
createRoot(document.getElementById("root")).render(<DesktopApp />);

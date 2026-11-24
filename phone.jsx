import React from "react";
import { createRoot } from "react-dom/client";
import { PhoneApp } from "./PhoneApp.jsx";
import "@tempo-v2/core-components/styles.css";
import "./style.css";

createRoot(document.getElementById("root")).render(<PhoneApp />);

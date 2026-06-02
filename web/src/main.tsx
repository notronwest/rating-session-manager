import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
// Design tokens — shared WMPC vocabulary; see ../../wmpc-meta/design-system/.
// New/edited inline styles should reference var(--token) instead of raw hex.
import "./tokens.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./index.css";

const rootElement = document.querySelector("#root");

if (!(rootElement instanceof HTMLDivElement)) {
  throw new Error("Missing root element for stella desktop.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import "./styles.css";
import "../../../packages/folio/src/styles/editor.css";
import { createRoot } from "react-dom/client";

import { App } from "./App";

const container = document.querySelector("#app");
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}

import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import { createFileComparisonRuntime } from "./runtime";
import { FileComparison } from "./view";
import "../shared/generated/style.css";

const container = document.querySelector("#app");
if (!container) {
  panic("MCP upload app root is missing");
}
const runtime = createFileComparisonRuntime();
createRoot(container).render(<FileComparison runtime={runtime} />);
await runtime.connect();

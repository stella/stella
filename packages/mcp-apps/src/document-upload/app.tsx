import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import { createDocumentUploadRuntime } from "./runtime";
import { DocumentUpload } from "./view";
import "../shared/generated/style.css";

const container = document.querySelector("#app");
if (!container) {
  panic("MCP upload app root is missing");
}
const runtime = createDocumentUploadRuntime();
createRoot(container).render(<DocumentUpload runtime={runtime} />);
await runtime.connect();

import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import { CASE_LAW_RESULTS_APP } from "../manifest";
import { createPresentationBridge } from "../shared/bridge";
import { createCaseLawParser } from "./parse";
import { CaseLawApp } from "./view";
import "../shared/generated/style.css";

const bridge = createPresentationBridge({
  manifest: CASE_LAW_RESULTS_APP,
  parse: createCaseLawParser(),
});
const root = document.querySelector("#app");
if (root === null) {
  panic("Case-law app mount is missing");
}
createRoot(root).render(<CaseLawApp bridge={bridge} />);
bridge.detached(bridge.connect(), "connect case-law app");

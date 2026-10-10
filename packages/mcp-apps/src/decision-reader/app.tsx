import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import { createReaderController } from "./controller";
import { ReaderView } from "./view";

// No cross-iframe supersession: hosts expose no conversation identity.
const controller = createReaderController();
const root = document.querySelector("#app");
if (root === null) {
  panic("Decision reader app mount is missing");
}
createRoot(root).render(<ReaderView host={controller} />);
controller.bridge.detached(
  controller.bridge.connect(),
  "connect decision reader",
);

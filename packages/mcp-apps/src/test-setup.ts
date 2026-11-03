import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach } from "bun:test";

import { DEFAULT_WAIT_TIMEOUT_MS } from "@stll/test-kit";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { configure } = await import("@testing-library/dom");
// This is a hang guard, not a speed assertion.
configure({ asyncUtilTimeout: DEFAULT_WAIT_TIMEOUT_MS });
const { cleanup } = await import("@testing-library/react");
afterEach(cleanup);

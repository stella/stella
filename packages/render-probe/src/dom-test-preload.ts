// Bun test preload: every DOM test runs under the render-storm check (see
// ./dom-test-guard.ts). Listed in each DOM-test workspace's bunfig.toml right
// after the event-loop watchdog, so the commit hook is in place before any
// test file loads React DOM.
// packages/scripts/src/dom-storm-preload-coverage.test.ts enforces the list.
import { afterEach, beforeEach } from "bun:test";

import { installDomTestStormGuard } from "./dom-test-guard";

const guard = installDomTestStormGuard();

beforeEach(() => {
  guard.begin();
  // A hook registered while a test starts runs right after the test body,
  // before every afterEach the test file registered: the check must see the
  // tree before the file's cleanup unmounts it.
  // ./dom-test-preload-order.dom.test.tsx holds Bun to that order.
  afterEach(guard.settle);
});

// Ends a test the hook above did not settle; otherwise a no-op.
afterEach(guard.settle);

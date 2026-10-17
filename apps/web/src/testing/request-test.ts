import { test } from "bun:test";

import { runInRequest } from "@stll/test-kit/request";

// Bun executes server branches of the web modules. Scope each browser-model
// scenario to a real request so API headers never read missing framework state.
export const requestTest = (name: string, scenario: () => unknown) =>
  test(name, async () => await runInRequest(scenario));

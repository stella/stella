import { expect, test } from "bun:test";

import { CAPABILITY_DISPATCH } from "@/api/mcp/generated/capability-dispatch";

const agentCapabilities = new Set(Object.keys(CAPABILITY_DISPATCH));

test("agents can follow organization exports but never start or download one", () => {
  expect(agentCapabilities.has("data-exports.get")).toBeTrue();
  expect(agentCapabilities.has("data-exports.list")).toBeTrue();
  expect(agentCapabilities.has("data-exports.create")).toBeFalse();
  expect(agentCapabilities.has("data-exports.download")).toBeFalse();
});

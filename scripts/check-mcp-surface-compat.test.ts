import { expect, test } from "bun:test";

import { releasedSurfaceBreaks } from "./check-mcp-surface-compat";

const search = { name: "search_case_law", inputSchema: { type: "object" } };
const singleToolProfile = { "": [0] };
const surface = (
  tools: (typeof search & { feature?: string; outputSchema?: object })[],
  profiles: Record<string, number[]> = singleToolProfile,
) => ({ tools, modes: { law: profiles } });

test("distinguishes a new tool from a removed tool across changing feature profiles", () => {
  const previous = surface([search], { "": [0], retired: [0] });
  const added = { ...search, name: "new_tool" };
  expect(
    releasedSurfaceBreaks(
      previous,
      surface([added, search], { "": [1], added: [0, 1] }),
    ),
  ).toEqual([]);
  expect(
    releasedSurfaceBreaks(
      previous,
      surface([added, search], { "": [1], added: [0] }),
    ),
  ).toEqual(["law search_case_law / tool-removed (enabled features: added)"]);
});

test("detects a newly imposed deployment gate and a removed output contract", () => {
  const previous = surface([{ ...search, outputSchema: { type: "object" } }]);
  expect(
    releasedSurfaceBreaks(previous, surface([{ ...search, feature: "FLAG" }])),
  ).toEqual([
    "law search_case_law /feature deployment-feature-required (enabled features: none)",
    "law search_case_law /outputSchema output-schema-removed (enabled features: none)",
  ]);
  expect(
    releasedSurfaceBreaks(surface([{ ...search, feature: "FLAG" }]), previous),
  ).toEqual([]);
});

test("rejects invalid references and missing feature combinations", () => {
  const previous = surface([search]);
  expect(() =>
    releasedSurfaceBreaks(previous, surface([search], { "": [2] })),
  ).toThrow("Unknown tool variant");
  expect(() =>
    releasedSurfaceBreaks(previous, surface([search], { "a,b": [0] })),
  ).toThrow("Incomplete profiles");
});

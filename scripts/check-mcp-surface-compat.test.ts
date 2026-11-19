import { expect, test } from "bun:test";

import { compareReleasedSurface } from "./check-mcp-surface-compat";

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
    compareReleasedSurface(
      previous,
      surface([added, search], { "": [1], added: [0, 1] }),
    ),
  ).toEqual({ failures: [], transitions: [] });
  expect(
    compareReleasedSurface(
      previous,
      surface([added, search], { "": [1], added: [0] }),
    ),
  ).toEqual({
    failures: ["law search_case_law / tool-removed (enabled features: added)"],
    transitions: [],
  });
});

test("detects a newly imposed deployment gate and a removed output contract", () => {
  const previous = surface([{ ...search, outputSchema: { type: "object" } }]);
  expect(
    compareReleasedSurface(previous, surface([{ ...search, feature: "FLAG" }])),
  ).toEqual({
    failures: [
      "law search_case_law /feature deployment-feature-required (enabled features: none)",
      "law search_case_law /outputSchema output-schema-removed (enabled features: none)",
    ],
    transitions: [],
  });
  expect(
    compareReleasedSurface(surface([{ ...search, feature: "FLAG" }]), previous),
  ).toEqual({ failures: [], transitions: [] });
});

test("rejects invalid references and missing feature combinations", () => {
  const previous = surface([search]);
  expect(() =>
    compareReleasedSurface(previous, surface([search], { "": [2] })),
  ).toThrow("Unknown tool variant");
  expect(() =>
    compareReleasedSurface(previous, surface([search], { "a,b": [0] })),
  ).toThrow("Incomplete profiles");
});

test("a legacy release reports additions separately while enforcing removals and input compatibility", () => {
  const previous = surface([
    {
      ...search,
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          state: { type: "string", enum: ["draft"] },
        },
      },
    },
  ]);
  const requiredInput = { type: "object", required: ["query"] };
  const next = surface([
    {
      ...search,
      inputSchema: requiredInput,
      outputSchema: {
        type: "object",
        properties: {
          terms: { type: "array" },
          state: { type: "string", examples: ["draft", "final"] },
        },
      },
    },
  ]);
  const { failures, transitions } = compareReleasedSurface(previous, next);
  expect(failures).toEqual([
    "law search_case_law /inputSchema/properties/query input-required-property-added (enabled features: none)",
    "law search_case_law /outputSchema/properties/title output-property-removed (enabled features: none)",
  ]);
  expect(transitions).toEqual([
    "law search_case_law /outputSchema/properties/state/examples/1 output-enum-expanded (enabled features: none)",
    "law search_case_law /outputSchema/properties/terms output-closed-object-property-added (enabled features: none)",
  ]);
});

test("an open release permits additions and prohibits reintroducing closed outputs even in new tools", () => {
  const open = {
    type: "object",
    properties: { state: { type: "string", examples: ["draft"] } },
  };
  const previous = surface([{ ...search, outputSchema: open }]);
  const added = { ...search, name: "new_tool", outputSchema: open };
  const expanded = {
    ...search,
    outputSchema: {
      type: "object",
      properties: {
        state: { type: "string", examples: ["draft", "final"] },
        terms: { type: "array" },
      },
    },
  };
  expect(
    compareReleasedSurface(
      previous,
      surface([expanded, added], { "": [0, 1] }),
    ),
  ).toEqual({ failures: [], transitions: [] });
  const closed = {
    ...added,
    outputSchema: { ...open, additionalProperties: false },
  };
  expect(
    compareReleasedSurface(
      previous,
      surface([expanded, closed], { "": [0, 1] }),
    ),
  ).toEqual({
    failures: [
      "law new_tool /outputSchema/additionalProperties output-object-closed (enabled features: none)",
    ],
    transitions: [],
  });
});

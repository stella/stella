import { expect, test } from "bun:test";

import {
  compareResponseConformanceDebt,
  responseConformanceDebt,
  responseConformanceGuardSelfTest,
} from "./response-conformance-guard";

const surface = {
  kind: "route",
  id: "GET /fixture",
  owner: "stella",
  response: { type: "missing" },
  httpTests: [],
  handlerTests: [],
  toolTests: [],
};
const census = (surfaces: unknown[]) => ({ version: 1, surfaces });

test("known debt passes while newly introduced debt fails", () => {
  const before = census([surface]);
  const baseline = responseConformanceDebt(before);
  expect(compareResponseConformanceDebt(baseline, before).violations).toEqual(
    [],
  );
  const added = census([surface, { ...surface, id: "GET /new" }]);
  expect(
    compareResponseConformanceDebt(baseline, added).violations,
  ).toHaveLength(2);
});

test("fixed debt must be pruned and cannot subsequently be restored", () => {
  const before = census([surface]);
  const baseline = responseConformanceDebt(before);
  const fixed = census([
    {
      ...surface,
      response: { type: "declared" },
      handlerTests: ["fixture.test.ts"],
    },
  ]);
  const result = compareResponseConformanceDebt(baseline, fixed);
  expect(result.violations).toEqual([]);
  expect(result.stale).toEqual(baseline.entries);
  expect(result.current.entries).toEqual([]);
  expect(
    compareResponseConformanceDebt(result.current, before).violations,
  ).toHaveLength(2);
});

test("schema exemption requires the explicit upstream owner and disposition", () => {
  const upstream = {
    ...surface,
    owner: "upstream",
    schemaExemption: "upstream-text-relay",
  };
  expect(responseConformanceDebt(census([upstream])).entries).toEqual([
    "route:GET /fixture missing-static-invocation",
  ]);
  expect(
    responseConformanceDebt(census([{ ...upstream, owner: "stella" }])).entries,
  ).toHaveLength(2);
  expect(
    responseConformanceDebt(census([{ ...surface, owner: "upstream" }]))
      .entries,
  ).toHaveLength(2);
});

test("each static invocation channel removes only invocation absence debt", () => {
  for (const channel of ["httpTests", "handlerTests", "toolTests"]) {
    const row = Object.fromEntries([
      ...Object.entries(surface),
      [channel, ["fixture.test.ts"]],
    ]);
    expect(responseConformanceDebt(census([row])).entries).toEqual([
      "route:GET /fixture missing-response-schema",
    ]);
  }
});

test("surface kinds retain distinct debt identities and input ordering is immaterial", () => {
  const rows = [
    surface,
    { ...surface, kind: "mcp" },
    { ...surface, kind: "capability" },
  ];
  const baseline = responseConformanceDebt(census(rows));
  expect(baseline.entries).toHaveLength(6);
  expect(responseConformanceDebt(census(rows.toReversed()))).toEqual(baseline);
});

test("malformed or duplicate census rows cannot silently remove debt", () => {
  expect(() => responseConformanceDebt({ version: 1 })).toThrow("surfaces");
  expect(() => responseConformanceDebt(census([surface, surface]))).toThrow(
    "Duplicate response conformance surface",
  );
  expect(() =>
    responseConformanceDebt(
      census([{ ...surface, response: { type: "unexpected" } }]),
    ),
  ).toThrow("unexpected");
});

test("the standalone guard self-test detects restored debt", () => {
  responseConformanceGuardSelfTest();
});

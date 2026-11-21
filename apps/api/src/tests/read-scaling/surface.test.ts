import { describe, expect, test } from "bun:test";

import {
  apiScalingSurface,
  mcpScalingSurface,
  parseScalingLedger,
  scalingCoverageViolations,
  withNewWriteRoutes,
} from "./surface";

describe("scaling coverage census", () => {
  test("a newly mounted GET or mutation requires a measurement or reason", () => {
    // Route table rows as the HTTP core lists them.
    const original = [{ method: "GET", path: "/v1/rows" }];
    const measured = apiScalingSurface(original).reads;
    const mutated = [
      ...original,
      { method: "GET", path: "/v1/rows/:id" },
      { method: "POST", path: "/v1/rows" },
    ];
    const surface = apiScalingSurface(mutated);
    expect(measured).toEqual(["GET /v1/rows"]);
    expect(
      scalingCoverageViolations({
        surface: surface.reads,
        measured,
        exemptions: [],
      }),
    ).toEqual(["unmeasured: GET /v1/rows/:id"]);
    expect(
      scalingCoverageViolations({
        surface: surface.writes,
        measured: [],
        exemptions: [],
      }),
    ).toEqual(["unmeasured: POST /v1/rows"]);
    const exemptions = [
      {
        id: "GET /v1/rows/:id",
        reason: "Requires a single-row permission fixture",
      },
    ];
    expect(
      scalingCoverageViolations({
        surface: surface.reads,
        measured,
        exemptions,
      }),
    ).toEqual([]);
    expect(
      scalingCoverageViolations({ surface: measured, measured, exemptions }),
    ).toEqual(["stale exemption: GET /v1/rows/:id"]);
  });

  test("tool annotations classify reads independently of tool spelling", () => {
    const surface = mcpScalingSurface([
      { name: "inspect", annotations: { readOnlyHint: true } },
      { name: "read_and_update", annotations: { readOnlyHint: false } },
    ]);
    expect(surface).toEqual({
      reads: ["inspect"],
      writes: ["read_and_update"],
    });
    expect(
      scalingCoverageViolations({
        surface: surface.reads,
        measured: [],
        exemptions: [],
      }),
    ).toEqual(["unmeasured: inspect"]);
  });

  test("ledger membership includes the section and rejects unreasoned entries", () => {
    expect(
      parseScalingLedger(
        JSON.stringify({
          unmeasuredReads: [
            { id: "GET /v1/rows", reason: "Requires a paginated read fixture" },
          ],
          pendingWriteHarness: [],
        }),
        "fixture",
      ),
    ).toEqual(["unmeasuredReads:GET /v1/rows"]);
    expect(() =>
      parseScalingLedger(
        JSON.stringify({
          unmeasuredReads: [{ id: "GET /v1/rows", reason: "" }],
          pendingWriteHarness: [],
        }),
        "fixture",
      ),
    ).toThrow("must contain reasoned");
  });

  test("a write route added with its reason may enter the pending write harness", () => {
    const base = ["pendingWriteHarness:POST /v1/rows"];
    const current = [
      "pendingWriteHarness:POST /v1/rows",
      "pendingWriteHarness:POST /v1/rows/apply",
    ];
    const writes = ["POST /v1/rows", "POST /v1/rows/apply"];
    expect(withNewWriteRoutes({ base, current, writes })).toEqual(current);
    // The same route without a reason is refused before any allowance.
    expect(() =>
      parseScalingLedger(
        JSON.stringify({
          unmeasuredReads: [],
          pendingWriteHarness: [{ id: "POST /v1/rows/apply", reason: "" }],
        }),
        "fixture",
      ),
    ).toThrow("must contain reasoned");
  });

  test("new read exemptions and entries for no mounted write stay new", () => {
    const base = ["pendingWriteHarness:POST /v1/rows"];
    const allowed = withNewWriteRoutes({
      base,
      current: [
        ...base,
        "unmeasuredReads:GET /v1/rows/apply",
        "pendingWriteHarness:POST /v1/unmounted",
      ],
      writes: ["POST /v1/rows", "GET /v1/rows/apply"],
    });
    expect(allowed).toEqual(base);
  });
});

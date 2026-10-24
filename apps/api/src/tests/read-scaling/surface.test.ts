import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import {
  apiScalingSurface,
  mcpScalingSurface,
  parseScalingLedger,
  scalingCoverageViolations,
} from "./surface";

describe("scaling coverage census", () => {
  test("a newly mounted GET or mutation requires a measurement or reason", () => {
    const original = new Elysia({ prefix: "/v1" }).get("/rows", () => []);
    const measured = apiScalingSurface(original.routes).reads;
    const mutated = original
      .get("/rows/:id", () => ({}))
      .post("/rows", () => ({}));
    const surface = apiScalingSurface(mutated.routes);
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
});

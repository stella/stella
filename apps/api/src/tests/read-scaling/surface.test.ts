import { describe, expect, test } from "bun:test";

import {
  discoverReadScalingSurface,
  readRouteSurface,
  scalingCoverageViolations,
} from "./surface";

describe("read scaling surface census", () => {
  test("new GET routes and missing or stale exemptions fail coverage", () => {
    const original = 'new Elysia().get("/rows", list.handler)';
    const mutated = `${original}.get("/rows/:id", read.handler)`;
    const measured = readRouteSurface("routes.ts", original);
    const surface = readRouteSurface("routes.ts", mutated);
    expect(measured).toHaveLength(1);
    expect(surface).toHaveLength(2);
    expect(
      scalingCoverageViolations({
        surface: measured,
        measured,
        exemptions: [],
      }),
    ).toEqual([]);
    expect(
      scalingCoverageViolations({ surface, measured, exemptions: [] }),
    ).toEqual(["unmeasured: GET routes.ts /rows/:id"]);
    const exemptions = [
      {
        id: "GET routes.ts /rows/:id",
        reason: "External service fixture requires a recorded response",
      },
    ];
    expect(
      scalingCoverageViolations({ surface, measured, exemptions }),
    ).toEqual([]);
    expect(
      scalingCoverageViolations({ surface: measured, measured, exemptions }),
    ).toEqual(["stale exemption: GET routes.ts /rows/:id"]);
  });

  test("enumerates repository GET declarations and read tools without importing services", async () => {
    const surface = await discoverReadScalingSurface();
    expect(surface.length).toBeGreaterThan(100);
    expect(surface).toContain("MCP list_documents");
    expect(surface).toContain(
      "GET apps/api/src/handlers/entities/routes.ts /entity/:entityId/versions",
    );
  });
});

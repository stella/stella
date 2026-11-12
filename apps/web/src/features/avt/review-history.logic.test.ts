import { describe, expect, test } from "bun:test";

import { historyChanges } from "@/features/avt/review-history.logic";
import type { ClaimDisposition } from "@/features/avt/types";

const disposition = (
  fields: Partial<ClaimDisposition> = {},
): ClaimDisposition => ({
  verdict: "contradicted",
  override: null,
  status: null,
  ...fields,
});

describe("historyChanges", () => {
  test("a note changes nothing a reviewer reads as a verdict or status", () => {
    expect(
      historyChanges({ before: disposition(), after: disposition() }),
    ).toEqual([]);
  });

  test("an override reads as the verdict it replaced and the one it set", () => {
    expect(
      historyChanges({
        before: disposition(),
        after: disposition({ override: "supported" }),
      }),
    ).toEqual([
      { type: "verdict", before: "contradicted", after: "supported" },
    ]);
  });

  test("an override equal to the verdict it annotates moves nothing", () => {
    expect(
      historyChanges({
        before: disposition({ override: "tension" }),
        after: disposition({ verdict: "tension", override: null }),
      }),
    ).toEqual([]);
  });

  test("a resolution that withdraws a status shows both changes, verdict first", () => {
    expect(
      historyChanges({
        before: disposition({
          verdict: "recordconflict",
          status: "needs-evidence",
        }),
        after: disposition({ verdict: "supported" }),
      }),
    ).toEqual([
      { type: "verdict", before: "recordconflict", after: "supported" },
      { type: "status", before: "needs-evidence", after: null },
    ]);
  });
});

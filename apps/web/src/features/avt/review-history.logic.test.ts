import { describe, expect, test } from "bun:test";

import {
  groupHistoryByOrigin,
  historyChanges,
} from "@/features/avt/review-history.logic";
import type { ClaimDisposition } from "@/features/avt/types";

describe("groupHistoryByOrigin", () => {
  const previous = {
    runId: "run-previous",
    runCreatedAt: "2026-11-09T09:30:00Z",
  };
  const earlier = { runId: "run-earlier", runCreatedAt: null };
  const entry = (
    id: string,
    carriedFrom: typeof previous | typeof earlier | null,
  ) => ({ id, carriedFrom });

  test("this run's actions stay plain and carried ones gather under one divider per run", () => {
    const entries = [
      entry("own-2", null),
      entry("own-1", null),
      entry("carried-3", previous),
      entry("carried-2", previous),
      entry("carried-1", earlier),
    ];
    expect(
      groupHistoryByOrigin(entries).map((group) => ({
        carriedFrom: group.carriedFrom?.runId ?? null,
        ids: group.entries.map(({ id }) => id),
      })),
    ).toEqual([
      { carriedFrom: null, ids: ["own-2", "own-1"] },
      { carriedFrom: "run-previous", ids: ["carried-3", "carried-2"] },
      { carriedFrom: "run-earlier", ids: ["carried-1"] },
    ]);
  });

  test("every entry lands in exactly one group, in the order given", () => {
    const entries = [
      entry("a", previous),
      entry("b", null),
      entry("c", previous),
    ];
    expect(
      groupHistoryByOrigin(entries).flatMap((group) => group.entries),
    ).toEqual(entries);
  });
});

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

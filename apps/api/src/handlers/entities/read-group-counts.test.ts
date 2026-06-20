import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import readGroupCounts from "./read-group-counts";

const workspaceId = toSafeId<"workspace">("ws_group_counts");
const organizationId = toSafeId<"organization">("org_group_counts");
const userId = toSafeId<"user">("user_group_counts");
const propertyId = toSafeId<"property">("prop_group_counts");

type GroupCountsCtx = Parameters<typeof readGroupCounts.handler>[0];

const createContext = ({
  body,
  safeDb,
}: {
  body: GroupCountsCtx["body"];
  safeDb: GroupCountsCtx["safeDb"];
}): GroupCountsCtx =>
  asTestRaw<GroupCountsCtx>({
    workspaceId,
    user: { id: userId },
    session: { activeOrganizationId: organizationId },
    memberRole: { role: "owner" },
    body,
    safeDb,
    request: new Request("https://example.test/v1/entities/group-counts"),
    route: "/v1/entities/:workspaceId/group-counts",
  });

// Single-select property path issues two safeDb calls in order: the grouped
// value counts (LATERAL unnest/scalar union), then the uncategorized NOT EXISTS
// count. Queue the results in that order so the test fails loudly if the call
// order changes.
const createSafeDb =
  (results: unknown[]): GroupCountsCtx["safeDb"] =>
  async <T>() => {
    const result = results.shift() ?? [];
    return Result.ok(asTestRaw<T>(result));
  };

describe("readGroupCounts", () => {
  test("single-select property: two values plus a non-zero uncategorized bucket", async () => {
    const result = await readGroupCounts.handler(
      createContext({
        body: { groupByPropertyId: propertyId, filters: [] },
        safeDb: createSafeDb([
          [
            { value: "alpha", count: 2 },
            { value: "beta", count: 1 },
          ],
          [{ count: 1 }],
        ]),
      }),
    );

    expect("counts" in result).toBe(true);
    if (!("counts" in result)) {
      return;
    }

    expect(result.counts).toEqual([
      { value: "alpha", count: 2 },
      { value: "beta", count: 1 },
      { value: null, count: 1 },
    ]);
  });

  test("zero uncategorized count is omitted", async () => {
    const result = await readGroupCounts.handler(
      createContext({
        body: { groupByPropertyId: propertyId, filters: [] },
        safeDb: createSafeDb([[{ value: "alpha", count: 3 }], [{ count: 0 }]]),
      }),
    );

    expect("counts" in result).toBe(true);
    if (!("counts" in result)) {
      return;
    }

    expect(result.counts).toEqual([{ value: "alpha", count: 3 }]);
  });
});

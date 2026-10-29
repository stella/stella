import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import { toSafeId } from "@/api/lib/branded-types";
import { loadConnectableMcpConnectorsForUser } from "@/api/lib/mcp-upstream/connections";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const organizationId = toSafeId<"organization">(
  "00000000-0000-0000-0000-000000000001",
);
const userId = toSafeId<"user">("00000000-0000-0000-0000-000000000002");

describe("connectable connector catalog", () => {
  test.each([0, 1, 20, 21])(
    "returns a deterministic bounded catalog for %s entries",
    async (count) => {
      const rows = Array.from({ length: count }, (_, index) => ({
        slug: `source-${String(index).padStart(2, "0")}`,
        displayName: `Source ${index}`,
      }));
      const query = {
        from: () => query,
        leftJoin: () => query,
        where: () => query,
        orderBy: () => query,
        limit: async (limit: number) => rows.slice(0, limit),
      };
      const safeDb: SafeDb = async (operation) =>
        Result.ok(
          await operation(
            asTestRaw<Parameters<typeof operation>[0]>({
              selectDistinctOn: () => query,
            }),
          ),
        );

      const result = await loadConnectableMcpConnectorsForUser({
        organizationId,
        safeDb,
        userId,
      });
      expect(result).toEqual(
        Result.ok({
          connectors: rows.slice(0, 20),
          continuation:
            count > 20
              ? { type: "more-available", afterSlug: "source-19" }
              : { type: "complete" },
        }),
      );
      expect(
        await loadConnectableMcpConnectorsForUser({
          organizationId,
          safeDb,
          userId,
        }),
      ).toEqual(result);
    },
  );
});

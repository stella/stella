import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import { createSafeId } from "@/api/lib/branded-types";
import { loadConnectableMcpConnectorsForUser } from "@/api/lib/mcp-upstream/connections";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const organizationId = createSafeId<"organization">();
const userId = createSafeId<"user">();

describe("connectable connector catalog", () => {
  test.each([0, 1, 20, 21])(
    "returns a complete catalog or an explicit overflow for %s entries",
    async (count) => {
      const rows = Array.from({ length: count }, (_, index) => ({
        slug: `source-${index}`,
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
      if (count <= 20) {
        expect(result).toEqual(Result.ok(rows));
        return;
      }
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toMatchObject({ status: 503 });
      }
    },
  );
});

import { Result } from "better-result";
import { expect, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import { VERSION_CONFLICT_ERROR_CODE } from "@/api/lib/optimistic-concurrency";
import {
  NO_AUDIT,
  NO_DB,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import updateJurisdictions from "./update";

type UpdateContext = Parameters<typeof updateJurisdictions.handler>[0];

test("rejects a stale practice-jurisdictions replacement token", async () => {
  let operations = 0;
  const safeDb: SafeDb = async () => {
    operations += 1;
    return Result.ok(
      asTestRaw({ updatedAt: new Date("2026-01-02T00:00:00.000Z") }),
    );
  };
  const result = await updateJurisdictions.handler(
    createTestHandlerContext<UpdateContext>({
      audit: NO_AUDIT,
      safeDb,
      scopedDb: NO_DB,
      body: {
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
        practiceJurisdictions: [{ countryCode: "CZ", isPrimary: true }],
      },
    }),
  );
  expect(result).toMatchObject({
    code: 409,
    response: { code: VERSION_CONFLICT_ERROR_CODE },
  });
  expect(operations).toBe(1);
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, gte } from "drizzle-orm";

import { SCOUT_KEY } from "@stll/api-contract/signals";
import { rejectionOf } from "@stll/property-testing/rejection";

import type { Transaction } from "@/api/db/root";
import { SCOUT_RUN_STATUS, scoutRuns } from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import { ModelRunError } from "@/api/lib/errors/provider-call-error";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import { runScout } from "@/api/lib/signals/scout";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const SENTINEL = "SENTINEL_SCOUT_OBSERVATION_TEXT";

let testDb: TestDatabase;
let ids: TestIds;
const startedAt = new Date();

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  try {
    await testDb
      .delete(scoutRuns)
      .where(
        and(
          eq(scoutRuns.organizationId, ids.orgA),
          eq(scoutRuns.scoutKey, SCOUT_KEY.MANUAL_REQUEST),
          gte(scoutRuns.startedAt, startedAt),
        ),
      );
  } finally {
    await releaseRlsFixture();
  }
});

const failedRunErrors = async (): Promise<(string | null)[]> =>
  (
    await testDb
      .select({ error: scoutRuns.error })
      .from(scoutRuns)
      .where(
        and(
          eq(scoutRuns.organizationId, ids.orgA),
          eq(scoutRuns.scoutKey, SCOUT_KEY.MANUAL_REQUEST),
          eq(scoutRuns.status, SCOUT_RUN_STATUS.FAILED),
          gte(scoutRuns.startedAt, startedAt),
        ),
      )
  ).map(({ error }) => error);

const recordFailure = async (thrown: unknown) => {
  const before = await failedRunErrors();
  const db = createRootScopedDb(
    {
      organizationId: ids.orgA,
      userId: ids.userA1,
      workspaceIds: [ids.wsA1],
    },
    asTestRaw<RlsDatabase<Transaction>>(testDb),
  );
  const rejection = await rejectionOf(
    runScout({
      db,
      organizationId: ids.orgA,
      scoutKey: SCOUT_KEY.MANUAL_REQUEST,
      observe: async () => {
        throw thrown;
      },
    }),
  );
  return { after: await failedRunErrors(), before, rejection };
};

describe("a failed scout observation", () => {
  const failures: { name: string; error: unknown; recorded: string }[] = [
    { name: "a library error", error: new Error(SENTINEL), recorded: "Error" },
    {
      name: "a type error",
      error: new TypeError(SENTINEL),
      recorded: "TypeError",
    },
    { name: "a thrown string", error: SENTINEL, recorded: "UnknownError" },
    {
      name: "a model run error",
      error: new ModelRunError({
        model: { provider: "openrouter", keySource: "instance" },
      }),
      recorded: "HandlerError",
    },
  ];

  for (const { name, error, recorded } of failures) {
    test(`records ${name} by its structural name`, async () => {
      const { after, before, rejection } = await recordFailure(error);

      expect(rejection).toBe(error);
      expect(after).toHaveLength(before.length + 1);
      expect(after.filter((value) => value === recorded)).toHaveLength(
        before.filter((value) => value === recorded).length + 1,
      );
      expect(JSON.stringify(after)).not.toContain(SENTINEL);
    });
  }
});

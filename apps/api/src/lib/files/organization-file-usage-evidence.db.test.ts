import { panic, Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { organizationFileObjects } from "@/api/db/schema";
import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import {
  authorizeOrganizationFileWrite,
  runCheckedOrganizationFileCopy,
  runCheckedOrganizationFileWrite,
} from "@/api/lib/files/organization-file-usage";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;
const priorFlag = envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS;

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = true;
});

afterAll(async () => {
  envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = priorFlag;
  await releaseTestDb();
});

test.each(["write", "copy", "absent"] as const)(
  "reserved %s settles through the database passed only to authorization",
  async (outcome) => {
    let transactions = 0;
    const db = asTestRaw<
      NonNullable<Parameters<typeof authorizeOrganizationFileWrite>[1]>
    >({
      transaction: async (...args: Parameters<TestDatabase["transaction"]>) => {
        transactions += 1;
        return await testDb.transaction(...args);
      },
    });
    const objectKey = `fixture/explicit-evidence-db-${outcome}`;
    const input = {
      organizationId: ids.orgA,
      objectKey,
      sizeBytes: 3,
      content: "written",
      source: "source",
      write: async () => "written",
      copy: async () =>
        outcome === "absent"
          ? Result.err("destination absent")
          : Result.ok("copied"),
      confirmedDestinationAbsentOnCopyError: (error: string) =>
        error === "destination absent",
    };
    expect(Object.hasOwn(input, "db")).toBe(false);
    const authorized = await authorizeOrganizationFileWrite(input, db);
    if (Result.isError(authorized)) {
      panic(
        "Explicit database reservation fixture was refused",
        authorized.error,
      );
    }
    expect(transactions).toBe(1);
    const settled = await authorized.value.execute(async (context) => {
      expect(context.proof.input.value.reservation.status).toBe("reserved");
      expect(context.proof.input.value.db?.transaction).toBe(db.transaction);
      return outcome === "write"
        ? await runCheckedOrganizationFileWrite(context)
        : await runCheckedOrganizationFileCopy(context);
    });
    expect(transactions).toBe(2);
    expect(settled).toEqual(
      outcome === "absent"
        ? Result.err("destination absent")
        : Result.ok(outcome === "write" ? "written" : "copied"),
    );
    const objects = await testDb
      .select({ status: organizationFileObjects.status })
      .from(organizationFileObjects)
      .where(eq(organizationFileObjects.objectKey, objectKey));
    expect(objects).toEqual(
      outcome === "absent" ? [] : [{ status: "committed" }],
    );
  },
);

import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { VERIFICATION_CODE_PATTERN } from "@stll/api-contract";

import { organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { entities, entityVersions, workspaces } from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { insertEntityVersion } from "@/api/lib/entity-versions/insert-entity-version";
import { isPgConstraintError, isPgError, PG_ERROR } from "@/api/lib/pg-error";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

/**
 * A verification-code collision is a one-in-8.2e14 draw, so a test cannot wait
 * for one. A BEFORE INSERT trigger forges it instead: it rewrites the code of
 * the next stamped row to one that is already taken, then disarms itself, so
 * the writer's first attempt collides for real - same index, same SQLSTATE -
 * and its second attempt runs untouched. Postgres fires BEFORE INSERT triggers
 * ahead of conflict detection, which is what makes the forgery reach the
 * arbiter at all.
 */
const FORCE_CODE_SETTING = "stella_test.force_vcode";

const VCODE_RE = new RegExp(VERIFICATION_CODE_PATTERN, "u");

let testDb: TestDatabase;
const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
const userId = toSafeId<"user">(`user_${Bun.randomUUIDv7()}`);
const workspaceId = createSafeId<"workspace">();
const entityId = createSafeId<"entity">();

const resetRole = async (tx: TestDatabaseTransaction) => {
  await tx.execute(sql.raw("RESET ROLE"));
};

/**
 * `once` disarms after the first stamped row, so the writer's second attempt
 * carries its own code; `always` never disarms, so no redraw can ever land.
 */
type ForcedCollisionMode = "always" | "once";

const armForcedCollision = async (
  tx: TestDatabaseTransaction,
  takenCode: string,
  mode: ForcedCollisionMode,
) => {
  const disarm =
    mode === "once"
      ? `PERFORM set_config('${FORCE_CODE_SETTING}', '', true);`
      : "";
  await tx.execute(
    sql.raw(`
      CREATE OR REPLACE FUNCTION stella_test_force_vcode() RETURNS trigger AS $$
      BEGIN
        IF NEW.verification_code IS NOT NULL
          AND coalesce(current_setting('${FORCE_CODE_SETTING}', true), '') <> ''
        THEN
          NEW.verification_code := current_setting('${FORCE_CODE_SETTING}', true);
          ${disarm}
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `),
  );
  await tx.execute(
    sql.raw(`
      CREATE TRIGGER stella_test_force_vcode_trigger
        BEFORE INSERT ON entity_versions
        FOR EACH ROW EXECUTE FUNCTION stella_test_force_vcode();
    `),
  );
  await tx.execute(
    sql`SELECT set_config(${FORCE_CODE_SETTING}, ${takenCode}, true)`,
  );
};

const disarmForcedCollision = async (tx: TestDatabaseTransaction) => {
  await tx.execute(
    sql.raw("DROP TRIGGER stella_test_force_vcode_trigger ON entity_versions"),
  );
};

beforeAll(
  async () => {
    testDb = await getTestDb();
    await testDb.transaction(async (tx) => {
      await resetRole(tx);
      await tx.insert(organization).values({
        id: organizationId,
        name: "Verification code matter",
        slug: `verification-code-${Bun.randomUUIDv7()}`,
        createdAt: new Date(),
      });
      await tx.insert(user).values({
        id: userId,
        name: "Verification Code User",
        email: `${userId}@example.test`,
      });
      await tx.insert(workspaces).values({
        id: workspaceId,
        organizationId,
        name: "Verification code matter",
        reference: Bun.randomUUIDv7().slice(0, 8),
      });
      await tx.insert(entities).values({
        id: entityId,
        workspaceId,
        kind: "document",
        name: "Stamped document",
        createdBy: userId,
        docSequence: 1,
      });
    });
  },
  { timeout: 60_000 },
);

afterAll(async () => {
  await testDb
    .delete(organization)
    .where(inArray(organization.id, [organizationId]));
  await releaseTestDb();
});

test("a verification-code collision is redrawn, and the row still lands", async () => {
  const takenCode = "zzzzzzzzzz";
  const collidingVersionId = createSafeId<"entityVersion">();

  await testDb.transaction(async (tx) => {
    await resetRole(tx);
    await tx.insert(entityVersions).values({
      id: createSafeId<"entityVersion">(),
      workspaceId,
      entityId,
      versionNumber: 1,
      stamp: "2026/001/001.v1",
      verificationCode: takenCode,
    });

    await armForcedCollision(tx, takenCode, "once");
    await insertEntityVersion(asTestRaw<Transaction>(tx), {
      id: collidingVersionId,
      workspaceId,
      entityId,
      versionNumber: 2,
      stamp: "2026/001/001.v2",
    });
    await disarmForcedCollision(tx);
  });

  const stored = await testDb
    .select({ verificationCode: entityVersions.verificationCode })
    .from(entityVersions)
    .where(eq(entityVersions.id, collidingVersionId));

  const verificationCode = stored.at(0)?.verificationCode;
  expect(verificationCode).not.toBe(takenCode);
  expect(verificationCode).toMatch(VCODE_RE);
});

test("a code that can never be redrawn fails loudly rather than looping", async () => {
  // Proves the forgery above is real: with the trigger never disarming, every
  // attempt hits the same taken code, and the writer gives up at its bound
  // instead of retrying forever or writing a duplicate.
  const takenCode = "yyyyyyyyyy";
  const failure: unknown = await testDb
    .transaction(async (tx) => {
      await resetRole(tx);
      await tx.insert(entityVersions).values({
        id: createSafeId<"entityVersion">(),
        workspaceId,
        entityId,
        versionNumber: 5,
        stamp: "2026/001/001.v5",
        verificationCode: takenCode,
      });
      await armForcedCollision(tx, takenCode, "always");
      await insertEntityVersion(asTestRaw<Transaction>(tx), {
        id: createSafeId<"entityVersion">(),
        workspaceId,
        entityId,
        versionNumber: 6,
        stamp: "2026/001/001.v6",
      });
    })
    .then(
      () => null,
      (error: unknown) => error,
    );

  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain("Verification code collided");
});

test("an unstamped version carries no verification code", async () => {
  const versionId = createSafeId<"entityVersion">();
  await testDb.transaction(async (tx) => {
    await resetRole(tx);
    await insertEntityVersion(asTestRaw<Transaction>(tx), {
      id: versionId,
      workspaceId,
      entityId,
      versionNumber: 3,
    });
  });

  const stored = await testDb
    .select({ verificationCode: entityVersions.verificationCode })
    .from(entityVersions)
    .where(eq(entityVersions.id, versionId));

  expect(stored.at(0)?.verificationCode).toBeNull();
});

test("a unique violation on any other constraint is not retried", async () => {
  // The statement names one arbiter index. A replayed id is a different bug
  // with different replay semantics, so it must still raise rather than be
  // quietly re-inserted under a fresh code.
  const replayedId = createSafeId<"entityVersion">();
  const values = {
    id: replayedId,
    workspaceId,
    entityId,
    versionNumber: 4,
    stamp: "2026/001/001.v4",
  };

  const failure: unknown = await testDb
    .transaction(async (tx) => {
      await resetRole(tx);
      await insertEntityVersion(asTestRaw<Transaction>(tx), values);
      await insertEntityVersion(asTestRaw<Transaction>(tx), values);
    })
    .then(
      () => null,
      (error: unknown) => error,
    );

  expect(failure).not.toBeNull();
  expect(isPgError(failure, PG_ERROR.UNIQUE_VIOLATION)).toBe(true);
  expect(
    isPgConstraintError(
      failure,
      PG_ERROR.UNIQUE_VIOLATION,
      "entity_versions_pkey",
    ),
  ).toBe(true);

  // The aborted transaction left nothing behind: no silent second row.
  const stored = await testDb
    .select({ id: entityVersions.id })
    .from(entityVersions)
    .where(eq(entityVersions.id, replayedId));
  expect(stored).toHaveLength(0);
});

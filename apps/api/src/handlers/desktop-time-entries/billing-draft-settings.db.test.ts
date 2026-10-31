import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import type { DesktopBillingDraftSettingsRequest } from "@stll/api-contract/desktop-billing-drafts";

import { auditLogs, billingDraftUserSettings } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

import { writeOwnBillingDraftSettings } from "./billing-draft-settings";

const ids = createTestIds();
let db: Awaited<ReturnType<typeof getTestDb>>;

// timeout: Builds the isolated PGlite schema and seeds both tenants once.
beforeAll(async () => {
  db = await getTestDb();
  await setupRlsTestData(db, ids);
}, 120_000);

beforeEach(async () => {
  await db
    .delete(billingDraftUserSettings)
    .where(eq(billingDraftUserSettings.organizationId, ids.orgA));
  await db.delete(auditLogs).where(eq(auditLogs.organizationId, ids.orgA));
});

afterAll(async () => {
  await releaseTestDb();
});

type WriteOptions = {
  userId?: SafeId<"user">;
  change: DesktopBillingDraftSettingsRequest;
  timeZone?: string;
};

/** One write through the caller's own RLS-scoped transaction, optionally
 * under a session TimeZone other than the one the revision was read in. */
const write = async ({ userId = ids.userA1, change, timeZone }: WriteOptions) =>
  (
    await createSafeDb(
      db,
      [],
      ids.orgA,
      userId,
    )(async (tx) => {
      if (timeZone !== undefined) {
        await tx.execute(sql`select set_config('TimeZone', ${timeZone}, true)`);
      }
      return await writeOwnBillingDraftSettings({
        tx,
        organizationId: ids.orgA,
        userId,
        change,
        recordAuditEvent: createAuditRecorder({
          organizationId: ids.orgA,
          userId,
          workspaceId: null,
          request: new Request("http://localhost/v1/desktop/billing-drafts"),
          server: null,
        }),
      });
    })
  ).unwrap();

const stored = async (userId = ids.userA1) =>
  (
    await db
      .select()
      .from(billingDraftUserSettings)
      .where(
        and(
          eq(billingDraftUserSettings.organizationId, ids.orgA),
          eq(billingDraftUserSettings.userId, userId),
        ),
      )
      .limit(1)
  ).at(0);

const audited = async (userId = ids.userA1) =>
  await db
    .select({ metadata: auditLogs.metadata })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.organizationId, ids.orgA),
        eq(auditLogs.resourceId, userId),
      ),
    )
    .limit(20);

test("a withdrawal applies after another device wrote since the caller read", async () => {
  const granted = await write({
    change: { type: "grant_consent", revision: null },
  });
  expect(granted?.consentAt).toBeInstanceOf(Date);
  const readByThisDevice = granted?.revision ?? null;
  const otherDevice = await write({
    change: {
      type: "set_preference",
      revision: readByThisDevice,
      preference: "Concise narratives",
    },
  });
  expect(otherDevice?.revision).not.toBe(readByThisDevice);

  const withdrawn = await write({ change: { type: "withdraw_consent" } });

  expect(withdrawn?.consentAt).toBeNull();
  expect(withdrawn?.revision).not.toBe(otherDevice?.revision);
  expect(await stored()).toMatchObject({
    consentAt: null,
    preference: "Concise narratives",
  });
  // The stale revision this device read cannot restore consent either.
  expect(
    await write({
      change: { type: "grant_consent", revision: readByThisDevice },
    }),
  ).toBeUndefined();
  expect((await stored())?.consentAt).toBeNull();
});

test("a withdrawal with no stored settings records a row without consent", async () => {
  expect(await stored(ids.userA2)).toBeUndefined();

  const withdrawn = await write({
    userId: ids.userA2,
    change: { type: "withdraw_consent" },
  });

  expect(withdrawn).toMatchObject({ consentAt: null, preference: null });
  expect(withdrawn?.revision).toEqual(expect.any(String));
  expect(await stored(ids.userA2)).toMatchObject({
    consentAt: null,
    preference: null,
  });
  expect(await audited(ids.userA2)).toMatchObject([
    {
      metadata: {
        settings: "personal-billing-drafts",
        consent: "revoked",
        preferenceChanged: false,
      },
    },
  ]);
});

test("a grant or preference change on a stale revision writes nothing", async () => {
  const first = await write({
    change: { type: "set_preference", revision: null, preference: "First" },
  });
  const second = await write({
    change: {
      type: "set_preference",
      revision: first?.revision ?? null,
      preference: "Second",
    },
  });
  expect(second?.preference).toBe("Second");
  const auditedBefore = (await audited()).length;

  for (const change of [
    { type: "grant_consent", revision: first?.revision ?? null },
    { type: "grant_consent", revision: null },
    {
      type: "set_preference",
      revision: first?.revision ?? null,
      preference: "Stale",
    },
    { type: "grant_consent", revision: "not a revision" },
  ] satisfies DesktopBillingDraftSettingsRequest[]) {
    expect(await write({ change })).toBeUndefined();
  }

  expect(await stored()).toMatchObject({
    consentAt: null,
    preference: "Second",
  });
  expect(await audited()).toHaveLength(auditedBefore);
});

test("a revision read in one session time zone matches in any other", async () => {
  let revision =
    (
      await write({
        change: { type: "set_preference", revision: null, preference: "Kept" },
        timeZone: "UTC",
      })
    )?.revision ?? null;
  for (const timeZone of ["Europe/Prague", "America/New_York"]) {
    // The fixture reaches the fault: the stored instant prints differently
    // in this zone, so a text comparison would refuse a current revision.
    const printed = (
      await createSafeDb(
        db,
        [],
        ids.orgA,
        ids.userA1,
      )(async (tx) => {
        await tx.execute(sql`select set_config('TimeZone', ${timeZone}, true)`);
        return await tx
          .select({
            text: sql<string>`${billingDraftUserSettings.updatedAt}::text`,
          })
          .from(billingDraftUserSettings)
          .where(eq(billingDraftUserSettings.userId, ids.userA1))
          .limit(1);
      })
    ).unwrap();
    expect(printed.at(0)?.text).not.toBe(revision);

    const granted = await write({
      change: { type: "grant_consent", revision },
      timeZone,
    });

    expect(granted?.consentAt).toBeInstanceOf(Date);
    revision = granted?.revision ?? null;
  }
});

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { DESKTOP_HANDOFF_FAILURE } from "@stll/api-contract/desktop-handoff";

import type { rootDb } from "@/api/db/root";
import { desktopEditHandoffs } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  consumeDesktopEditHandoff,
  recordDesktopHandoffFailure,
  DesktopHandoffAccountMismatchError,
} from "@/api/lib/desktop-edit-handoffs";
import {
  createDesktopEditHandoffToken,
  hashDesktopEditHandoffToken,
} from "@/api/lib/desktop-edit-sessions";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

const REDEMPTION_TIME = new Date("2026-10-01T12:00:00.000Z");

let testDb: TestDatabase;
let ids: TestIds;
let db: Pick<typeof rootDb, "update" | "select">;
const handoffIds: SafeId<"desktopEditHandoff">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  db = asTestRaw<Pick<typeof rootDb, "update" | "select">>(testDb);
});

afterAll(async () => {
  try {
    if (handoffIds.length > 0) {
      await testDb
        .delete(desktopEditHandoffs)
        .where(inArray(desktopEditHandoffs.id, handoffIds));
    }
  } finally {
    await releaseRlsFixture();
  }
});

const seedHandoff = async (
  expiresAt = new Date(REDEMPTION_TIME.getTime() + 60_000),
) => {
  const id = createSafeId<"desktopEditHandoff">();
  const handoffToken = createDesktopEditHandoffToken();
  await testDb.insert(desktopEditHandoffs).values({
    id,
    workspaceId: ids.wsA1,
    entityId: ids.entityA1,
    propertyId: ids.filePropertyA1,
    createdBy: ids.userA1,
    apiBaseUrl: "https://api.example.test",
    tokenHash: hashDesktopEditHandoffToken(handoffToken),
    expiresAt,
  });
  handoffIds.push(id);
  return { id, handoffToken };
};

test("document links report the account selection before redemption", async () => {
  const { id, handoffToken } = await seedHandoff();
  for (const identity of [
    { userId: ids.userA2, organizationId: ids.orgA },
    { userId: ids.userA1, organizationId: ids.orgB },
    { userId: ids.userB1, organizationId: ids.orgB },
  ]) {
    const result = await consumeDesktopEditHandoff({
      handoffToken,
      identity,
      db,
      now: REDEMPTION_TIME,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(DesktopHandoffAccountMismatchError);
      expect(result.error).toMatchObject({
        status: 409,
        code: "desktop_account_mismatch",
        message: "Desktop is linked to a different account or organization.",
      });
    }
  }
  const rows = await testDb
    .select({ consumedAt: desktopEditHandoffs.consumedAt })
    .from(desktopEditHandoffs)
    .where(eq(desktopEditHandoffs.id, id));
  expect(rows.at(0)?.consumedAt).toBeNull();
  expect(
    await consumeDesktopEditHandoff({
      handoffToken,
      identity: { userId: ids.userA1, organizationId: ids.orgA },
      db,
      now: REDEMPTION_TIME,
    }).then((result) => result.unwrap()),
  ).toMatchObject({ id, createdBy: ids.userA1 });
});

test("a document link is single use and expires before redemption", async () => {
  const identity = { userId: ids.userA1, organizationId: ids.orgA };
  const { handoffToken } = await seedHandoff();
  expect(
    await consumeDesktopEditHandoff({
      handoffToken,
      identity,
      db,
      now: REDEMPTION_TIME,
    }).then((result) => result.unwrap()),
  ).not.toBeNull();
  expect(
    await consumeDesktopEditHandoff({
      handoffToken,
      identity,
      db,
      now: REDEMPTION_TIME,
    }).then((result) => result.unwrap()),
  ).toBeNull();
  const expired = await seedHandoff(REDEMPTION_TIME);
  expect(
    await consumeDesktopEditHandoff({
      handoffToken: expired.handoffToken,
      identity,
      db,
      now: REDEMPTION_TIME,
    }).then((result) => result.unwrap()),
  ).toBeNull();
});

test("token failure acknowledgement is terminal, scoped and replay safe", async () => {
  const pending = await seedHandoff();
  const unrelated = await seedHandoff();
  const acknowledge = async (handoffToken: string) =>
    recordDesktopHandoffFailure({
      kind: "desktop_edit",
      handoffToken,
      reason: DESKTOP_HANDOFF_FAILURE.updateRequired,
      db: asTestRaw<Pick<typeof rootDb, "transaction">>(testDb),
      now: REDEMPTION_TIME,
    });
  expect(await acknowledge(pending.handoffToken)).toBe(true);
  expect(await acknowledge(pending.handoffToken)).toBe(false);
  expect(await acknowledge(createDesktopEditHandoffToken())).toBe(false);
  const rows = await testDb
    .select({
      id: desktopEditHandoffs.id,
      failedAt: desktopEditHandoffs.failedAt,
      failureReason: desktopEditHandoffs.failureReason,
    })
    .from(desktopEditHandoffs)
    .where(inArray(desktopEditHandoffs.id, [pending.id, unrelated.id]));
  expect(rows.find((row) => row.id === pending.id)).toEqual({
    id: pending.id,
    failedAt: REDEMPTION_TIME,
    failureReason: DESKTOP_HANDOFF_FAILURE.updateRequired,
  });
  expect(rows.find((row) => row.id === unrelated.id)?.failedAt).toBeNull();
  expect(
    (
      await consumeDesktopEditHandoff({
        handoffToken: pending.handoffToken,
        identity: { userId: ids.userA1, organizationId: ids.orgA },
        db,
        now: REDEMPTION_TIME,
      })
    ).unwrap(),
  ).toBeNull();
  const expired = await seedHandoff(REDEMPTION_TIME);
  expect(await acknowledge(expired.handoffToken)).toBe(false);
  await consumeDesktopEditHandoff({
    handoffToken: unrelated.handoffToken,
    identity: { userId: ids.userA1, organizationId: ids.orgA },
    db,
    now: REDEMPTION_TIME,
  });
  expect(await acknowledge(unrelated.handoffToken)).toBe(false);
});

test.each(["failure", "redemption"] as const)(
  "document handoff keeps the first terminal outcome: %s",
  async (first) => {
    const { id, handoffToken } = await seedHandoff();
    const fail = async () =>
      await recordDesktopHandoffFailure({
        kind: "desktop_edit",
        handoffToken,
        reason: DESKTOP_HANDOFF_FAILURE.accountRequired,
        db: asTestRaw<Pick<typeof rootDb, "transaction">>(testDb),
        now: REDEMPTION_TIME,
      });
    const redeem = async () =>
      (
        await consumeDesktopEditHandoff({
          handoffToken,
          identity: { userId: ids.userA1, organizationId: ids.orgA },
          db,
          now: REDEMPTION_TIME,
        })
      ).unwrap();
    if (first === "failure") {
      expect(await fail()).toBe(true);
      expect(await redeem()).toBeNull();
    } else {
      expect(await redeem()).not.toBeNull();
      expect(await fail()).toBe(false);
    }
    const rows = await testDb
      .select({
        consumedAt: desktopEditHandoffs.consumedAt,
        failedAt: desktopEditHandoffs.failedAt,
      })
      .from(desktopEditHandoffs)
      .where(eq(desktopEditHandoffs.id, id));
    expect(rows).toEqual([
      first === "failure"
        ? { consumedAt: null, failedAt: REDEMPTION_TIME }
        : { consumedAt: REDEMPTION_TIME, failedAt: null },
    ]);
  },
);

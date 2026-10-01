import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import type { rootDb } from "@/api/db/root";
import { desktopEditHandoffs } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { consumeDesktopEditHandoff } from "@/api/lib/desktop-edit-handoffs";
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
let db: Pick<typeof rootDb, "update">;
const handoffIds: SafeId<"desktopEditHandoff">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  db = asTestRaw<Pick<typeof rootDb, "update">>(testDb);
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

test("a different account cannot consume another account's document link", async () => {
  const { id, handoffToken } = await seedHandoff();
  for (const identity of [
    { userId: ids.userA2, organizationId: ids.orgA },
    { userId: ids.userA1, organizationId: ids.orgB },
    { userId: ids.userB1, organizationId: ids.orgB },
  ]) {
    expect(
      await consumeDesktopEditHandoff({
        handoffToken,
        identity,
        db,
        now: REDEMPTION_TIME,
      }),
    ).toBeNull();
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
    }),
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
    }),
  ).not.toBeNull();
  expect(
    await consumeDesktopEditHandoff({
      handoffToken,
      identity,
      db,
      now: REDEMPTION_TIME,
    }),
  ).toBeNull();
  const expired = await seedHandoff(REDEMPTION_TIME);
  expect(
    await consumeDesktopEditHandoff({
      handoffToken: expired.handoffToken,
      identity,
      db,
      now: REDEMPTION_TIME,
    }),
  ).toBeNull();
});

import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import {
  timeEntries,
  timeEntryTimerStates,
  timeTimers,
  workspaceMembers,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { guardRunningTimeEntries } from "@/api/lib/billing/time-entry-running";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);
const ids = createTestIds();
let db: TestDatabase;
const createdEntryIds: (typeof timeEntries.$inferSelect.id)[] = [];
const START = new Date("2026-09-01T10:00:00Z");

beforeAll(async () => {
  db = await getTestDb();
  await setupRlsTestData(db, ids);
});
afterAll(async () => {
  await releaseTestDb();
});
beforeEach(async () => {
  await db.delete(timeTimers).where(eq(timeTimers.organizationId, ids.orgA));
  if (createdEntryIds.length > 0) {
    await db
      .delete(timeEntries)
      .where(inArray(timeEntries.id, createdEntryIds.splice(0)));
  }
  await db
    .update(member)
    .set({ role: "member" })
    .where(eq(member.id, ids.memberA2org));
  await db
    .insert(workspaceMembers)
    .values({ id: ids.memberA1wsA2, workspaceId: ids.wsA2, userId: ids.userA1 })
    .onConflictDoNothing();
});

const createEntry = async (clock: "direct" | "projected" = "direct") => {
  const id = createSafeId<"timeEntry">();
  await db.insert(timeEntries).values({
    id,
    organizationId: ids.orgA,
    userId: ids.userA1,
    workspaceId: ids.wsA2,
    dateWorked: "2026-09-01",
    timezoneId: "UTC",
    durationMinutes: 1,
    billedMinutes: 1,
    narrative: "Recorded work",
    rateAtEntry: cents(0),
    currency: "USD",
    billable: false,
    source: "timer",
    timerStartedAt: clock === "direct" ? START : null,
    timerStoppedAt: null,
  });
  createdEntryIds.push(id);
  return id;
};
const createLinkedTimer = async (
  entryId: typeof timeEntries.$inferSelect.id,
) => {
  const timerId = createSafeId<"timeTimer">();
  await db.insert(timeTimers).values({
    id: timerId,
    organizationId: ids.orgA,
    userId: ids.userA1,
    workspaceId: ids.wsA2,
    legacyTimeEntryId: entryId,
    state: "running",
    startedAt: START,
    lastResumedAt: START,
  });
  return timerId;
};
const signal = async (entryId: typeof timeEntries.$inferSelect.id) =>
  (
    await db
      .select({ state: timeEntryTimerStates.state })
      .from(timeEntryTimerStates)
      .where(eq(timeEntryTimerStates.entryId, entryId))
      .limit(1)
  ).at(0)?.state;
const memberGuard = async (entryId: typeof timeEntries.$inferSelect.id) =>
  await createScopedDb(
    db,
    [ids.wsA2],
    ids.orgA,
    ids.userA2,
  )((tx) =>
    guardRunningTimeEntries({
      tx,
      workspaceId: ids.wsA2,
      actorUserId: ids.userA2,
      selection: { type: "entries", ids: [entryId] },
    }),
  );

const ownerDb = () => createScopedDb(db, [], ids.orgA, ids.userA1);

test("members see the running signal even when the linked timer is private", async () => {
  const entryId = await createEntry();
  await createLinkedTimer(entryId);
  const otherMember = createScopedDb(db, [ids.wsA2], ids.orgA, ids.userA2);
  expect(await otherMember((tx) => tx.select().from(timeTimers))).toEqual([]);
  expect(await signal(entryId)).toBe("running");
  expect(await memberGuard(entryId)).toMatchObject({
    status: 409,
    code: "running_timer",
  });
});

test("pause and resume update the guard without requiring matter access", async () => {
  const entryId = await createEntry();
  const timerId = await createLinkedTimer(entryId);
  await db
    .delete(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, ids.wsA2),
        eq(workspaceMembers.userId, ids.userA1),
      ),
    );
  await ownerDb()((tx) =>
    tx
      .update(timeTimers)
      .set({ state: "paused", lastResumedAt: null })
      .where(eq(timeTimers.id, timerId)),
  );
  expect(await signal(entryId)).toBe("paused");
  expect(await memberGuard(entryId)).toBeNull();
  await ownerDb()((tx) =>
    tx
      .update(timeTimers)
      .set({ state: "running", lastResumedAt: START })
      .where(eq(timeTimers.id, timerId)),
  );
  expect(await signal(entryId)).toBe("running");
  expect(await memberGuard(entryId)).toMatchObject({ code: "running_timer" });
});

test("moving the legacy pointer stops the original signal and starts its successor", async () => {
  const originalId = await createEntry();
  const successorId = await createEntry("projected");
  const timerId = await createLinkedTimer(originalId);
  await ownerDb()((tx) =>
    tx
      .update(timeTimers)
      .set({ legacyTimeEntryId: successorId })
      .where(eq(timeTimers.id, timerId)),
  );
  expect(await signal(originalId)).toBe("paused");
  expect(await signal(successorId)).toBe("running");
  expect(await memberGuard(originalId)).toBeNull();
  expect(await memberGuard(successorId)).toMatchObject({
    code: "running_timer",
  });
});

test("deleting or detaching a timer leaves a stopped signal until the entry is deleted", async () => {
  const entryId = await createEntry();
  const timerId = await createLinkedTimer(entryId);
  await ownerDb()((tx) =>
    tx
      .update(timeTimers)
      .set({ legacyTimeEntryId: null })
      .where(eq(timeTimers.id, timerId)),
  );
  expect(await signal(entryId)).toBe("paused");
  await ownerDb()((tx) =>
    tx
      .update(timeTimers)
      .set({ legacyTimeEntryId: entryId })
      .where(eq(timeTimers.id, timerId)),
  );
  await ownerDb()((tx) =>
    tx.delete(timeTimers).where(eq(timeTimers.id, timerId)),
  );
  expect(await signal(entryId)).toBe("paused");
  expect(await memberGuard(entryId)).toBeNull();
  await db.delete(timeEntries).where(eq(timeEntries.id, entryId));
  expect(await signal(entryId)).toBeUndefined();
});

test("a direct legacy entry without a projection keeps the timestamp definition", async () => {
  const entryId = await createEntry();
  expect(await signal(entryId)).toBeUndefined();
  expect(await memberGuard(entryId)).toMatchObject({ code: "running_timer" });
  await db
    .update(timeEntries)
    .set({ timerStoppedAt: START })
    .where(eq(timeEntries.id, entryId));
  expect(await memberGuard(entryId)).toBeNull();
});

test("signal writes cannot hide a running clock or expose another organization's signal", async () => {
  const entryId = await createEntry();
  await createLinkedTimer(entryId);
  const anotherMember = createScopedDb(db, [], ids.orgA, ids.userA2);
  expect(
    await anotherMember((tx) =>
      tx
        .update(timeEntryTimerStates)
        .set({ state: "paused" })
        .where(eq(timeEntryTimerStates.entryId, entryId))
        .returning(),
    ),
  ).toEqual([]);
  await db
    .update(member)
    .set({ role: "admin" })
    .where(eq(member.id, ids.memberA2org));
  expect(
    await anotherMember((tx) =>
      tx
        .update(timeEntryTimerStates)
        .set({ state: "paused" })
        .where(eq(timeEntryTimerStates.entryId, entryId))
        .returning(),
    ),
  ).toEqual([]);
  expect(await signal(entryId)).toBe("running");
  await expect(
    createScopedDb(
      db,
      [ids.wsA2],
      ids.orgA,
      ids.userA2,
    )((tx) =>
      tx
        .update(timeEntryTimerStates)
        .set({ state: "paused" })
        .where(eq(timeEntryTimerStates.entryId, entryId)),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } });
  await expect(
    ownerDb()((tx) =>
      tx
        .delete(timeEntryTimerStates)
        .where(eq(timeEntryTimerStates.entryId, entryId)),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } });
  expect(await signal(entryId)).toBe("running");
  expect(
    await createScopedDb(
      db,
      [],
      ids.orgB,
      ids.userB1,
    )((tx) => tx.select().from(timeEntryTimerStates)),
  ).toEqual([]);
});

test("a paused signal cannot be fabricated for a direct running entry", async () => {
  const entryId = await createEntry();
  await expect(
    ownerDb()((tx) =>
      tx.insert(timeEntryTimerStates).values({
        entryId,
        organizationId: ids.orgA,
        userId: ids.userA1,
        state: "paused",
      }),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } });
  expect(await signal(entryId)).toBeUndefined();
  expect(await memberGuard(entryId)).toMatchObject({ code: "running_timer" });
});

test("a paused signal cannot be moved onto a direct running entry", async () => {
  const projectedId = await createEntry("projected");
  const timerId = await createLinkedTimer(projectedId);
  await ownerDb()((tx) =>
    tx
      .update(timeTimers)
      .set({ state: "paused", lastResumedAt: null })
      .where(eq(timeTimers.id, timerId)),
  );
  const directId = await createEntry();
  await expect(
    ownerDb()((tx) =>
      tx
        .update(timeEntryTimerStates)
        .set({ entryId: directId })
        .where(eq(timeEntryTimerStates.entryId, projectedId)),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } });
  expect(await signal(projectedId)).toBe("paused");
  expect(await signal(directId)).toBeUndefined();
  expect(await memberGuard(directId)).toMatchObject({ code: "running_timer" });
});

test("foreign projections are visible only with access to their legacy entry", async () => {
  const entryId = await createEntry();
  await createLinkedTimer(entryId);
  expect(
    await createScopedDb(
      db,
      [],
      ids.orgA,
      ids.userA2,
    )((tx) => tx.select().from(timeEntryTimerStates)),
  ).toEqual([]);
  expect(
    await createScopedDb(
      db,
      [],
      ids.orgA,
      ids.userA1,
    )((tx) => tx.select().from(timeEntryTimerStates)),
  ).toHaveLength(1);
  expect(
    await createScopedDb(
      db,
      [ids.wsA2],
      ids.orgA,
      ids.userA2,
    )((tx) => tx.select().from(timeEntryTimerStates)),
  ).toHaveLength(1);
});

test("entry deletion cascades the signal and unlinks a still-running timer", async () => {
  const entryId = await createEntry();
  const timerId = await createLinkedTimer(entryId);
  await db.delete(timeEntries).where(eq(timeEntries.id, entryId));
  expect(await signal(entryId)).toBeUndefined();
  expect(
    (
      await db
        .select({ legacyTimeEntryId: timeTimers.legacyTimeEntryId })
        .from(timeTimers)
        .where(eq(timeTimers.id, timerId))
    ).at(0)?.legacyTimeEntryId,
  ).toBeNull();
});

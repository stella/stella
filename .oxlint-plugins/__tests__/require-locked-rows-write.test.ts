import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

const RULE = "require-locked-rows-write";

// The batch approval shape: a filtered lock, a policy check on its rows, then
// a write that repeats the filter.
const filteredLock = `
const open = and(inArray(t.id, ids), eq(t.status, STATUS.SUBMITTED));
const rows = await tx.select({ id: t.id }).from(t).where(open).for("update");
check(rows);`;

const lint = async (body: string) =>
  await lintSingleRule(
    RULE,
    `async function run(tx, ids, id, w) {\n${body}\n}`,
  );

describe("require-locked-rows-write", () => {
  test("reports a write that repeats a filtered lock's WHERE", async () => {
    expect(
      await lint(`${filteredLock}
await tx.update(t).set({ status: STATUS.APPROVED }).where(open);
await tx.delete(t).where(and(inArray(t.id, ids), eq(t.status, STATUS.SUBMITTED)));`),
    ).toEqual([6, 7]);
  });

  test("reports both write lock strengths, not a share lock", async () => {
    expect(
      await lint(`const rows = await tx.select().from(t).where(eq(t.status, "open")).for("no key update");
await tx.update(t).set({ seen: true }).where(eq(t.status, "open"));
const others = await tx.select().from(u).where(eq(u.status, "open")).for("update");
await tx.delete(u).where(eq(u.status, "open"));
await tx.select().from(v).where(eq(v.status, "open")).for("share");
await tx.delete(v).where(eq(v.status, "open"));`),
    ).toEqual([3, 5]);
  });

  test("reports writes that read the lock but can widen past it", async () => {
    expect(
      await lint(`${filteredLock}
const lockedIds = rows.map((row) => row.id);
await tx.update(t).set({ done: true }).where(or(inArray(t.id, lockedIds), open));
await tx.update(t).set({ done: true }).where(and(notInArray(t.id, lockedIds), open));
await tx.update(t).set({ done: true }).where(and(open, eq(t.kind, rows[0].kind)));`),
    ).toEqual([7, 8, 9]);
  });

  test("resolves schema members and local aliases to one table", async () => {
    expect(
      await lint(`const entries = schema.timeEntries;
await tx.select().from(schema.timeEntries).where(eq(entries.status, "open")).for("update");
await tx.update(timeEntries).set({ x: 1 }).where(eq(timeEntries.status, "open"));
await tx.delete(entries).where(eq(schema.timeEntries.status, "open"));`),
    ).toEqual([4, 5]);
  });

  test("accepts ids chosen elsewhere and rows a guarded write returned", async () => {
    expect(
      await lint(`await tx.select().from(t).where(eq(t.id, id)).for("update");
await tx.update(t).set({ stale: true }).where(inArray(t.id, [...dependents]));
await tx.select().from(t).where(and(inArray(t.id, ids), eq(t.lease, lease))).for("update");
const started = await tx.update(t).set({ s: 1 }).where(and(inArray(t.id, ids), eq(t.lease, lease))).returning({ id: t.id });
await tx.update(t).set({ n: 1 }).where(inArray(t.id, started.map(({ id }) => id)));`),
    ).toEqual([]);
  });

  test("accepts writes derived from the locked rows", async () => {
    expect(
      await lint(`${filteredLock}
const lockedIds = rows.map((row) => row.id);
await tx.update(t).set({ done: true }).where(inArray(t.id, lockedIds));
const kept = [];
for (const row of rows) { if (row.ok) kept.push(row.id); }
await tx.delete(t).where(inArray(t.id, kept));
await tx.update(t).set({ a: 1 }).from(sql\`(VALUES \${sql.join(rows.map((r) => sql\`(\${r.id})\`))}) AS v(id)\`).where(eq(t.id, sql\`v.id\`));`),
    ).toEqual([]);
  });

  test("reads a listed table's own primary key as its row identity", async () => {
    expect(
      await lint(`const owned = await tx.select().from(workObligations).where(and(eq(workObligations.ownerUserId, id), inArray(workObligations.status, OPEN))).for("update");
await tx.update(workObligations).set({ s: 1 }).where(and(inArray(workObligations.entityId, owned.map((row) => row.entityId)), eq(workObligations.ownerUserId, id), inArray(workObligations.status, OPEN)));
await tx.update(workObligations).set({ s: 2 }).where(and(inArray(workObligations.workspaceId, owned.map((row) => row.workspaceId)), eq(workObligations.ownerUserId, id), inArray(workObligations.status, OPEN)));
const rows = await tx.select().from(t).where(eq(t.status, "open")).for("update");
await tx.update(t).set({ s: 1 }).where(and(inArray(t.entityId, rows.map((row) => row.entityId)), eq(t.status, "open")));`),
    ).toEqual([4, 6]);
  });

  test("accepts a write that keeps a key-shaped lock's whole predicate", async () => {
    expect(
      await lint(`const where = and(eq(t.workspaceId, w), inArray(t.id, ids));
await tx.select().from(t).where(where).for("update");
await tx.delete(t).where(and(where, eq(t.status, "draft")));
const [row] = await tx.select().from(t).where(and(eq(t.id, id), eq(t.status, "open"))).for("update");
await tx.update(t).set({ x: 1 }).where(eq(t.id, id));`),
    ).toEqual([]);
  });

  test("reports a key write whose lock filtered on state", async () => {
    expect(
      await lint(`await tx.select().from(t).where(and(eq(t.workspaceId, w), inArray(t.status, OPEN_STATUSES))).for("update");
await tx.update(t).set({ x: 1 }).where(and(eq(t.workspaceId, w), inArray(t.status, OPEN_STATUSES)));`),
    ).toEqual([3]);
  });

  test("accepts writes that do not repeat the lock's filter", async () => {
    expect(
      await lint(`const own = await tx.select().from(t).where(and(eq(t.userId, user), inArray(t.status, OPEN))).for("update");
await tx.delete(t).where(eq(t.userId, user));
await tx.update(t).set({ isDefault: false }).where(and(eq(t.workspaceId, w), eq(t.isDefault, true)));
await tx.update(t).set({ seen: true });
const locked = await lockRowsForWrite({ table: u, query: tx.select({ id: u.id }).from(u).where(eq(u.state, "staged")) });
await tx.update(u).set({ state: "rejected" }).where(and(eq(u.sourceId, source), ne(u.id, locked.ids[0])));`),
    ).toEqual([]);
  });

  test("accepts a write pinned to the ids lockRowsForWrite returned", async () => {
    expect(
      await lint(`const locked = await lockRowsForWrite({ table: t, query: tx.select({ id: t.id }).from(t).where(eq(t.status, "open")) });
await tx.delete(t).where(and(inArray(t.id, locked.ids), eq(t.status, "open")));`),
    ).toEqual([]);
  });

  test("ignores other tables, writes before the lock, and a lock in another transaction", async () => {
    expect(
      await lint(`await tx.update(t).set({ x: 1 }).where(eq(t.status, "open"));
await tx.select().from(t).where(eq(t.status, "open")).for("update");
await tx.update(other).set({ x: 1 }).where(eq(other.status, "open"));
await safeDb((inner) => inner.select().from(u).where(eq(u.status, "open")).for("update"));
await safeDb(async (inner) => inner.update(u).set({ x: 1 }).where(eq(u.status, "open")));`),
    ).toEqual([]);
  });

  test("requires writes after lockRowsForWrite to filter by locked.where()", async () => {
    expect(
      await lint(`const locked = await lockRowsForWrite({ table: t, query: tx.select().from(t).where(eq(t.status, "open")) });
await tx.update(t).set({ status: "done" }).where(locked.where());
await tx.delete(t).where(locked.where(eq(t.kind, "draft")));
await tx.update(t).set({ status: "done" }).where(eq(t.status, "open"));
await tx.update(t).set({ status: "done" }).where(or(locked.where(), eq(t.status, "open")));
await tx.update(other).set({ status: "done" });`),
    ).toEqual([5, 6]);
  });

  test("accepts a destructured where() and knows the owner's other lock helpers", async () => {
    expect(
      await lint(`const { rows, where } = await lockRowsForWrite({ table: t, query: q });
await tx.update(t).set({ s: 1 }).where(where(eq(t.kind, "draft")));
const candidates = await lockUnbillableRateCandidates(tx, condition);
await tx.update(timeEntries).set({ billable: true }).where(candidates.where());
await tx.update(timeEntries).set({ billable: true }).where(condition);`),
    ).toEqual([6]);
  });

  test("honours a reasoned exemption on the write", async () => {
    expect(
      await lint(`${filteredLock}
// oxlint-disable-next-line ${RULE}/${RULE} -- the write must also reach rows added after the lock
await tx.update(t).set({ status: STATUS.APPROVED }).where(open);`),
    ).toEqual([]);
  });
});

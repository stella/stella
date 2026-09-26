import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { inArray, sql } from "drizzle-orm";

import { correspondenceDropLogs } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import listDrops from "./list";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;
const seededIds: SafeId<"correspondenceDropLog">[] = [];
const tiedAt = new Date("2026-09-26T12:00:00.000Z");
const olderAt = new Date("2026-09-25T12:00:00.000Z");

type DropItem = {
  id: SafeId<"correspondenceDropLog">;
  sender: string;
  receivedAt: Date;
  reason: string;
  setupHint: string | null;
};
type DropPage = {
  items: DropItem[];
  nextCursor: string | null;
  limit: number;
};

const seed = async ({
  workspaceId,
  organizationId,
  senderAddress,
  reason = "unauthorized_sender",
  receivedAt = tiedAt,
}: {
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  senderAddress: string;
  reason?: "unauthorized_sender" | "authentication_failed";
  receivedAt?: Date;
}) => {
  const id = createSafeId<"correspondenceDropLog">();
  await testDb.insert(correspondenceDropLogs).values({
    id,
    workspaceId,
    organizationId,
    senderAddress,
    reason,
    receivedAt,
  });
  seededIds.push(id);
  return id;
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  await testDb.execute(
    sql`ALTER TABLE correspondence_drop_logs FORCE ROW LEVEL SECURITY`,
  );
}, 60_000);

afterAll(async () => {
  await testDb
    .delete(correspondenceDropLogs)
    .where(inArray(correspondenceDropLogs.id, seededIds));
  await releaseRlsFixture();
});

const read = async ({
  workspaceId = ids.wsA1,
  organizationId = ids.orgA,
  userId = ids.userA1,
  cursor,
  limit,
}: {
  workspaceId?: SafeId<"workspace">;
  organizationId?: SafeId<"organization">;
  userId?: SafeId<"user">;
  cursor?: string;
  limit?: number;
} = {}) =>
  await listDrops.handler(
    asTestRaw<Parameters<typeof listDrops.handler>[0]>({
      memberRole: { role: "owner" },
      request: new Request(
        "https://api.example.test/v1/workspaces/correspondence/drops",
      ),
      route: "/v1/workspaces/:workspaceId/correspondence/drops",
      query: {
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
      },
      safeDb: createSafeDb(testDb, [workspaceId], organizationId, userId),
      session: { activeOrganizationId: organizationId },
      user: { id: userId },
      workspaceId,
    }),
  );

describe("correspondence drop-log read boundary", () => {
  test("keyset pages traverse tied timestamps once and expose only the public fields", async () => {
    const tiedIds: SafeId<"correspondenceDropLog">[] = [];
    for (let index = 0; index < 5; index += 1) {
      tiedIds.push(
        await seed({
          workspaceId: ids.wsA1,
          organizationId: ids.orgA,
          senderAddress: `sender-${index}@example.test`,
          reason: index === 0 ? "authentication_failed" : "unauthorized_sender",
        }),
      );
    }
    const olderId = await seed({
      workspaceId: ids.wsA1,
      organizationId: ids.orgA,
      senderAddress: "older@example.test",
      receivedAt: olderAt,
    });
    const expectedIds = [...tiedIds]
      .toSorted((left, right) => Number(left < right) - Number(left > right))
      .concat(olderId);
    const collected: DropItem[] = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const page = asTestRaw<DropPage>(await read({ cursor, limit: 2 }));
      expect(page.limit).toBe(2);
      expect(page.items.length).toBeLessThanOrEqual(2);
      collected.push(...page.items);
      cursor = page.nextCursor ?? undefined;
      if (cursor === undefined) {
        break;
      }
    }
    expect(collected.map(({ id }) => id)).toEqual(expectedIds);
    expect(new Set(collected.map(({ id }) => id)).size).toBe(
      expectedIds.length,
    );
    for (const item of collected) {
      expect(Object.keys(item).toSorted()).toEqual([
        "id",
        "reason",
        "receivedAt",
        "sender",
        "setupHint",
      ]);
      expect(item).not.toHaveProperty("organizationId");
      expect(item).not.toHaveProperty("workspaceId");
    }
    expect(collected.find(({ id }) => id === tiedIds.at(0))?.setupHint).toBe(
      "configure_sender_spf_dkim_dmarc",
    );
    expect(
      collected
        .filter(({ reason }) => reason !== "authentication_failed")
        .every(({ setupHint }) => setupHint === null),
    ).toBe(true);
  });

  test("rejects a malformed cursor with status 400", async () => {
    const result = await read({ cursor: "not-a-cursor" });
    expect(result).toEqual({
      code: 400,
      response: { message: "Invalid pagination cursor" },
    });
  });

  test("does not read another matter or organization through a scoped handle", async () => {
    const siblingId = await seed({
      workspaceId: ids.wsA2,
      organizationId: ids.orgA,
      senderAddress: "sibling@example.test",
    });
    const foreignId = await seed({
      workspaceId: ids.wsB1,
      organizationId: ids.orgB,
      senderAddress: "foreign@example.test",
    });
    const own = asTestRaw<DropPage>(
      await read({
        workspaceId: ids.wsA1,
        organizationId: ids.orgA,
        userId: ids.userA1,
      }),
    );
    expect(own.items.map(({ id }) => id)).not.toContain(siblingId);
    expect(own.items.map(({ id }) => id)).not.toContain(foreignId);
    const sibling = asTestRaw<DropPage>(
      await read({
        workspaceId: ids.wsA2,
        organizationId: ids.orgA,
        userId: ids.userA2,
      }),
    );
    expect(sibling.items.map(({ id }) => id)).toContain(siblingId);
    expect(sibling.items.map(({ id }) => id)).not.toContain(foreignId);
    const foreign = asTestRaw<DropPage>(
      await read({
        workspaceId: ids.wsB1,
        organizationId: ids.orgB,
        userId: ids.userB1,
      }),
    );
    expect(foreign.items.map(({ id }) => id)).toContain(foreignId);
    expect(foreign.items.map(({ id }) => id)).not.toContain(siblingId);
  });
});

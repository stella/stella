import type { InferOk } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import { contacts, workspaceContacts, workspaces } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { readWorkspaceContactsHandler } from "./workspace-contacts-read";

let db: TestDatabase;
const organizationId = mintAuthProviderId<"organization">();
const workspaceId = createSafeId<"workspace">();
const contactId = createSafeId<"contact">();
beforeAll(
  async () => {
    db = await getTestDb();
    await db.insert(organization).values({
      id: organizationId,
      name: "Contact order",
      slug: organizationId,
      createdAt: new Date(),
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      name: "Contact order",
      reference: `test_${workspaceId}`,
    });
    await db.insert(contacts).values({
      id: contactId,
      organizationId,
      type: "person",
      displayName: "Party",
    });
  },
  { timeout: 30_000 },
);
afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, organizationId));
  await releaseTestDb();
});
const read = async () =>
  await readWorkspaceContactsHandler({
    workspaceId,
    scopedDb: asTestRaw<
      Parameters<typeof readWorkspaceContactsHandler>[0]["scopedDb"]
    >(createScopedDb(db, [workspaceId], organizationId, null)),
  });

test("contact links are returned in stable creation and identity order", async () => {
  const newerId = createSafeId<"workspaceContact">();
  const olderId = createSafeId<"workspaceContact">();
  const middleId = createSafeId<"workspaceContact">();
  await db.insert(workspaceContacts).values([
    {
      id: newerId,
      organizationId,
      workspaceId,
      contactId,
      role: "other",
      createdAt: new Date("2026-02-03"),
    },
    {
      id: olderId,
      organizationId,
      workspaceId,
      contactId,
      role: "witness",
      createdAt: new Date("2026-02-01"),
    },
    {
      id: middleId,
      organizationId,
      workspaceId,
      contactId,
      role: "judge",
      createdAt: new Date("2026-02-02"),
    },
  ]);
  const initialRead = (await read()).unwrap();
  expect(initialRead.overflow).toBe(false);
  expect(initialRead.contacts.map(({ id }) => id)).toEqual([
    olderId,
    middleId,
    newerId,
  ]);
  await db
    .update(workspaceContacts)
    .set({ createdAt: new Date("2026-02-01") })
    .where(eq(workspaceContacts.workspaceId, workspaceId));
  expect((await read()).unwrap().contacts.map(({ id }) => id)).toEqual(
    [olderId, middleId, newerId].toSorted(),
  );
  await db
    .delete(workspaceContacts)
    .where(eq(workspaceContacts.workspaceId, workspaceId));
});

test("an overflowing matter returns visible contacts and an overflow flag", async () => {
  // A stored overflow is simulated at the read boundary; the database capacity
  // test separately proves that ordinary writes cannot create one.
  const rows = Array.from(
    { length: LIMITS.workspaceContactsCount + 1 },
    () =>
      ({
        id: createSafeId<"workspaceContact">(),
        organizationId,
        workspaceId,
        contactId,
        role: "witness",
        isPrimary: false,
        notes: null,
        createdAt: new Date("2026-02-01"),
        contact: null,
      }) as const satisfies InferOk<
        Awaited<ReturnType<typeof readWorkspaceContactsHandler>>
      >["contacts"][number],
  );
  const scopedDb = asTestRaw<
    Parameters<typeof readWorkspaceContactsHandler>[0]["scopedDb"]
  >(
    async (readRows: (tx: unknown) => Promise<unknown>) =>
      await readRows({
        query: {
          workspaceContacts: {
            findMany: async ({ limit }: { limit: number }) =>
              rows.slice(0, limit),
          },
        },
      }),
  );
  const result = await readWorkspaceContactsHandler({ workspaceId, scopedDb });
  expect(result.isOk()).toBe(true);
  expect(result.unwrap()).toEqual({
    contacts: rows.slice(0, LIMITS.workspaceContactsCount),
    overflow: true,
  });
});

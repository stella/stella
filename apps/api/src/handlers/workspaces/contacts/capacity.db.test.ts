import { Result, panic } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { organization } from "@/api/db/auth-schema";
import { contacts, workspaceContacts, workspaces } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let db: TestDatabase;
let organizationId = mintAuthProviderId<"organization">();
let sourceId = createSafeId<"workspace">();
let targetId = createSafeId<"workspace">();
let contactIds = Array.from({ length: LIMITS.workspaceContactsCount + 1 }, () =>
  createSafeId<"contact">(),
);

beforeAll(async () => {
  db = await getTestDb();
}, 300_000);
afterAll(releaseTestDb);
beforeEach(async () => {
  organizationId = mintAuthProviderId<"organization">();
  sourceId = createSafeId<"workspace">();
  targetId = createSafeId<"workspace">();
  contactIds = Array.from({ length: LIMITS.workspaceContactsCount + 1 }, () =>
    createSafeId<"contact">(),
  );
  await db.insert(organization).values({
    id: organizationId,
    name: "Contact capacity",
    slug: `contact-capacity-${organizationId}`,
    createdAt: new Date(),
  });
  await db.insert(workspaces).values(
    [sourceId, targetId].map((id) => ({
      id,
      organizationId,
      name: "Contact capacity",
      reference: `test_${id}`,
    })),
  );
  await db.insert(contacts).values(
    contactIds.map((id) => ({
      id,
      organizationId,
      type: "person" as const,
      displayName: "Capacity contact",
    })),
  );
});
afterEach(async () => {
  await db.delete(organization).where(eq(organization.id, organizationId));
});

const fill = async (workspaceId: typeof sourceId) => {
  await db.insert(workspaceContacts).values(
    contactIds.slice(0, LIMITS.workspaceContactsCount).map((contactId) => ({
      workspaceId,
      organizationId,
      contactId,
      role: "other" as const,
    })),
  );
};

const overflowContactId = () => {
  const contactId = contactIds.at(LIMITS.workspaceContactsCount);
  if (!contactId) {
    panic("Capacity fixture is missing its overflow contact");
  }
  return contactId;
};

const insertSourceContact =
  (contactId: (typeof contactIds)[number]) => async () =>
    await db.insert(workspaceContacts).values({
      workspaceId: sourceId,
      organizationId,
      contactId,
      role: "other",
    });

const expectCapacityRefusal = async (write: () => Promise<unknown>) => {
  const outcome = await Result.tryPromise(write);
  expect(outcome.isErr()).toBe(true);
  if (outcome.isOk()) {
    return;
  }
  let cause: unknown = outcome.error;
  while (cause instanceof Error && cause.cause instanceof Error) {
    cause = cause.cause;
  }
  expect(cause).toMatchObject({
    code: "23514",
    constraint: "workspace_contacts_workspace_capacity",
  });
};

test("database capacity equals the application bound and rejects an unmediated extra link", async () => {
  await fill(sourceId);
  expect(
    await db.$count(
      workspaceContacts,
      eq(workspaceContacts.workspaceId, sourceId),
    ),
  ).toBe(LIMITS.workspaceContactsCount);
  await expectCapacityRefusal(
    async () =>
      await db.insert(workspaceContacts).values({
        organizationId,
        workspaceId: sourceId,
        contactId: overflowContactId(),
        role: "other",
      }),
  );
  expect(
    await db.$count(
      workspaceContacts,
      eq(workspaceContacts.workspaceId, sourceId),
    ),
  ).toBe(LIMITS.workspaceContactsCount);
});

test("unlinking frees capacity and edits to an existing link remain allowed", async () => {
  await fill(sourceId);
  const link = (
    await db
      .select()
      .from(workspaceContacts)
      .where(eq(workspaceContacts.workspaceId, sourceId))
  ).at(0);
  expect(link).toBeDefined();
  if (!link) {
    return;
  }
  await db
    .update(workspaceContacts)
    .set({ workspaceId: sourceId, notes: "Updated" })
    .where(eq(workspaceContacts.id, link.id));
  await db.delete(workspaceContacts).where(eq(workspaceContacts.id, link.id));
  await db.insert(workspaceContacts).values({
    organizationId,
    workspaceId: sourceId,
    contactId: link.contactId,
    role: link.role,
  });
  expect(
    await db.$count(
      workspaceContacts,
      eq(workspaceContacts.workspaceId, sourceId),
    ),
  ).toBe(LIMITS.workspaceContactsCount);
});

test("a new matter accepts a bulk copy at capacity and cascade deletion releases all links", async () => {
  await fill(sourceId);
  await db.delete(workspaces).where(eq(workspaces.id, targetId));
  await db.transaction(async (tx) => {
    await tx.insert(workspaces).values({
      id: targetId,
      organizationId,
      name: "Copied matter",
      reference: `test_${targetId}`,
    });
    const sourceLinks = await tx
      .select()
      .from(workspaceContacts)
      .where(eq(workspaceContacts.workspaceId, sourceId));
    await tx.insert(workspaceContacts).values(
      sourceLinks.map(({ contactId, role, isPrimary, notes }) => ({
        workspaceId: targetId,
        organizationId,
        contactId,
        role,
        isPrimary,
        notes,
      })),
    );
  });
  expect(
    await db.$count(
      workspaceContacts,
      eq(workspaceContacts.workspaceId, targetId),
    ),
  ).toBe(LIMITS.workspaceContactsCount);
  await db.delete(workspaces).where(eq(workspaces.id, sourceId));
  expect(
    await db.$count(
      workspaceContacts,
      eq(workspaceContacts.workspaceId, sourceId),
    ),
  ).toBe(0);
  const contactId = contactIds.at(0);
  if (!contactId) {
    panic("Capacity fixture is missing its first contact");
  }
  await db.delete(contacts).where(eq(contacts.id, contactId));
  expect(
    await db.$count(
      workspaceContacts,
      eq(workspaceContacts.workspaceId, targetId),
    ),
  ).toBe(LIMITS.workspaceContactsCount - 1);
});

test("an over-capacity bulk insert writes no links", async () => {
  await expectCapacityRefusal(
    async () =>
      await db.insert(workspaceContacts).values(
        contactIds.map((contactId) => ({
          workspaceId: sourceId,
          organizationId,
          contactId,
          role: "other" as const,
        })),
      ),
  );
  expect(
    await db.$count(
      workspaceContacts,
      eq(workspaceContacts.workspaceId, sourceId),
    ),
  ).toBe(0);
});

test("moving a link to a matter with capacity preserves its identity", async () => {
  const [link] = await db
    .insert(workspaceContacts)
    .values({
      organizationId,
      workspaceId: sourceId,
      contactId: overflowContactId(),
      role: "other",
    })
    .returning();
  if (!link) {
    panic("Capacity fixture link was not created");
  }
  const [moved] = await db
    .update(workspaceContacts)
    .set({ workspaceId: targetId })
    .where(eq(workspaceContacts.id, link.id))
    .returning();
  expect(moved).toMatchObject({
    id: link.id,
    workspaceId: targetId,
    contactId: link.contactId,
  });
  expect(
    await db.$count(
      workspaceContacts,
      eq(workspaceContacts.workspaceId, sourceId),
    ),
  ).toBe(0);
});

test("moving a link into a full matter is refused atomically", async () => {
  await fill(targetId);
  const [link] = await db
    .insert(workspaceContacts)
    .values({
      organizationId,
      workspaceId: sourceId,
      contactId: overflowContactId(),
      role: "other",
    })
    .returning();
  expect(link).toBeDefined();
  if (!link) {
    return;
  }
  await expectCapacityRefusal(
    async () =>
      await db
        .update(workspaceContacts)
        .set({ workspaceId: targetId })
        .where(eq(workspaceContacts.id, link.id)),
  );
  expect(
    await db.$count(
      workspaceContacts,
      eq(workspaceContacts.workspaceId, sourceId),
    ),
  ).toBe(1);
  expect(
    await db.$count(
      workspaceContacts,
      eq(workspaceContacts.workspaceId, targetId),
    ),
  ).toBe(LIMITS.workspaceContactsCount);
});

test("contact link mutations preserve the database capacity", async () => {
  await assertProperty(
    "contact link mutations preserve the database capacity",
    fc.asyncProperty(
      fc.array(fc.constantFrom("insert", "delete"), {
        minLength: 1,
        maxLength: 24,
      }),
      async (actions) => {
        await db
          .delete(workspaceContacts)
          .where(eq(workspaceContacts.workspaceId, sourceId));
        await fill(sourceId);
        for (const action of actions) {
          // db-await-in-loop: each generated transition depends on the previous committed state
          const before = await db
            .select()
            .from(workspaceContacts)
            .where(eq(workspaceContacts.workspaceId, sourceId));
          if (action === "delete") {
            const link = before.at(0);
            if (link) {
              // db-await-in-loop: deleting the observed link is this state transition
              await db
                .delete(workspaceContacts)
                .where(eq(workspaceContacts.id, link.id));
            }
          } else {
            const used = new Set(before.map(({ contactId }) => contactId));
            const contactId = contactIds.find(
              (candidate) => !used.has(candidate),
            );
            if (!contactId) {
              panic("Generated capacity fixture must have an unused contact");
            }
            const write = insertSourceContact(contactId);
            if (before.length === LIMITS.workspaceContactsCount) {
              // db-await-in-loop: assert the refused transition before advancing the generated state
              await expectCapacityRefusal(write);
            } else {
              // db-await-in-loop: applying the admitted transition before observing the next state
              await write();
            }
          }
          // db-await-in-loop: observe the invariant after every generated transition
          const count = await db.$count(
            workspaceContacts,
            eq(workspaceContacts.workspaceId, sourceId),
          );
          expect(count).toBeLessThanOrEqual(LIMITS.workspaceContactsCount);
          expect(count).toBe(
            action === "delete"
              ? Math.max(0, before.length - 1)
              : Math.min(LIMITS.workspaceContactsCount, before.length + 1),
          );
        }
      },
    ),
    { numRuns: 12 },
  );
});

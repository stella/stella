import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq, isNull, sql } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { anonymizationBlacklistEntries, workspaces } from "@/api/db/schema";
import {
  normalizeAnonymizationBlacklistEntry,
  replaceOrganizationAnonymizationBlacklist,
} from "@/api/lib/anonymization-blacklist";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

/**
 * Three tenancy tiers share this table: an organization's firm-wide terms,
 * another organization's, and matter-scoped terms the settings page owns
 * neither way. The fixture seeds all three and asserts only the first moves.
 *
 * The row a term already on the list keeps is the other property under test.
 * It carries `createdBy` and `createdAt` — who first asked for a name to be
 * masked, and when — so a replace that re-created the row instead of updating
 * it would quietly rewrite that history while looking correct from outside.
 *
 * What this cannot reach: the `isNull(workspace_id)` on the delete and the
 * `setWhere` on the upsert are defence in depth, not the acting guard. The
 * ids both statements address come from
 * `loadOrganizationAnonymizationTermsForWrite`, which is already scoped to
 * this organization's org-wide rows, so no fixture driving this function can
 * put a foreign id in front of them. Removing either guard leaves these tests
 * green; the scope they duplicate is pinned in
 * `anonymization-write-cap.db.test.ts`.
 */

setDefaultTimeout(120_000);

let testDb: TestDatabase;

const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
const otherOrganizationId = toSafeId<"organization">(
  `org_${Bun.randomUUIDv7()}`,
);
const userId = toSafeId<"user">(`user_${Bun.randomUUIDv7()}`);
const originalAuthorId = toSafeId<"user">(`user_${Bun.randomUUIDv7()}`);
const workspaceId = toSafeId<"workspace">(Bun.randomUUIDv7());

const keptId = createSafeId<"anonymizationBlacklistEntry">();
const droppedId = createSafeId<"anonymizationBlacklistEntry">();
const otherOrgId = createSafeId<"anonymizationBlacklistEntry">();
const matterScopedId = createSafeId<"anonymizationBlacklistEntry">();

const CREATED_AT = new Date("2026-01-02T03:04:05.000Z");

const runReplace = async (terms: { canonical: string; label: string }[]) =>
  await testDb.transaction(async (tx) => {
    await tx.execute(sql.raw("RESET ROLE"));
    return await replaceOrganizationAnonymizationBlacklist({
      entries: terms.map((term) => normalizeAnonymizationBlacklistEntry(term)),
      organizationId,
      tx: asTestRaw<Transaction>(tx),
      userId,
    });
  });

const orgWideRows = async (owner: SafeId<"organization">) =>
  await testDb
    .select({
      id: anonymizationBlacklistEntries.id,
      canonical: anonymizationBlacklistEntries.canonical,
      label: anonymizationBlacklistEntries.label,
      createdBy: anonymizationBlacklistEntries.createdBy,
      createdAt: anonymizationBlacklistEntries.createdAt,
      updatedBy: anonymizationBlacklistEntries.updatedBy,
    })
    .from(anonymizationBlacklistEntries)
    .where(
      and(
        eq(anonymizationBlacklistEntries.organizationId, owner),
        isNull(anonymizationBlacklistEntries.workspaceId),
      ),
    );

beforeAll(async () => {
  testDb = await getTestDb();

  await testDb.transaction(async (tx) => {
    await tx.execute(sql.raw("RESET ROLE"));
    await tx.insert(organization).values([
      {
        id: organizationId,
        name: "Masking firm",
        slug: organizationId,
        createdAt: new Date(),
      },
      {
        id: otherOrganizationId,
        name: "Other firm",
        slug: otherOrganizationId,
        createdAt: new Date(),
      },
    ]);
    await tx.insert(user).values([
      { id: userId, name: "Editor", email: `${userId}@test.local` },
      {
        id: originalAuthorId,
        name: "First author",
        email: `${originalAuthorId}@test.local`,
      },
    ]);
    await tx.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      name: "Matter",
      reference: Bun.randomUUIDv7().slice(0, 8),
    });
    await tx.insert(anonymizationBlacklistEntries).values([
      {
        // Stays on the submitted list, so its row has to survive intact.
        id: keptId,
        organizationId,
        label: "Client",
        canonical: "Acme Holdings",
        variants: ["Acme"],
        createdBy: originalAuthorId,
        updatedBy: originalAuthorId,
        createdAt: CREATED_AT,
      },
      {
        // Absent from the submitted list, so the replace drops it.
        id: droppedId,
        organizationId,
        label: "Client",
        canonical: "Stale Term",
        variants: [],
        createdBy: originalAuthorId,
        updatedBy: originalAuthorId,
      },
      {
        // Another firm's firm-wide term.
        id: otherOrgId,
        organizationId: otherOrganizationId,
        label: "Client",
        canonical: "Acme Holdings",
        variants: [],
        createdBy: originalAuthorId,
        updatedBy: originalAuthorId,
      },
      {
        // This firm's matter-scoped term, which the settings page owns
        // neither way.
        id: matterScopedId,
        organizationId,
        workspaceId,
        label: "Witness",
        canonical: "Matter Only",
        variants: [],
        createdBy: originalAuthorId,
        updatedBy: originalAuthorId,
      },
    ]);
  });
});

afterAll(async () => {
  await testDb.transaction(async (tx) => {
    await tx.execute(sql.raw("RESET ROLE"));
    await tx.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await tx
      .delete(organization)
      .where(eq(organization.id, otherOrganizationId));
    await tx.delete(organization).where(eq(organization.id, organizationId));
    await tx.delete(user).where(eq(user.id, userId));
    await tx.delete(user).where(eq(user.id, originalAuthorId));
  });
  await releaseTestDb();
});

test("a term already on the list keeps its row, and a new one is added", async () => {
  const result = await runReplace([
    // Same term, re-cased and relabelled: it must update the existing row
    // rather than create a second one.
    { canonical: "ACME Holdings", label: "Counterparty" },
    { canonical: "Fresh Term", label: "Client" },
  ]);

  expect(result).toEqual({ deletedCount: 1 });

  const rows = await orgWideRows(organizationId);
  expect(rows).toHaveLength(2);

  const kept = rows.find((row) => row.id === keptId);
  expect(kept?.canonical).toBe("ACME Holdings");
  expect(kept?.label).toBe("Counterparty");
  // The provenance of the original entry survives the replace.
  expect(kept?.createdBy).toBe(originalAuthorId);
  expect(kept?.createdAt).toEqual(CREATED_AT);
  expect(kept?.updatedBy).toBe(userId);

  const added = rows.find((row) => row.canonical === "Fresh Term");
  expect(added?.createdBy).toBe(userId);
  expect(rows.some((row) => row.id === droppedId)).toBe(false);
});

test("another organization's terms and this one's matter terms are untouched", async () => {
  const otherRows = await orgWideRows(otherOrganizationId);
  expect(otherRows).toEqual([
    expect.objectContaining({
      id: otherOrgId,
      canonical: "Acme Holdings",
      label: "Client",
      updatedBy: originalAuthorId,
    }),
  ]);

  const matterRows = await testDb
    .select({
      id: anonymizationBlacklistEntries.id,
      label: anonymizationBlacklistEntries.label,
      updatedBy: anonymizationBlacklistEntries.updatedBy,
    })
    .from(anonymizationBlacklistEntries)
    .where(eq(anonymizationBlacklistEntries.workspaceId, workspaceId));
  expect(matterRows).toEqual([
    { id: matterScopedId, label: "Witness", updatedBy: originalAuthorId },
  ]);
});

test("an empty list clears this organization's firm-wide terms only", async () => {
  const result = await runReplace([]);

  expect(result).toEqual({ deletedCount: 2 });
  expect(await orgWideRows(organizationId)).toEqual([]);
  expect(await orgWideRows(otherOrganizationId)).toHaveLength(1);

  const matterRows = await testDb
    .select({ id: anonymizationBlacklistEntries.id })
    .from(anonymizationBlacklistEntries)
    .where(eq(anonymizationBlacklistEntries.workspaceId, workspaceId));
  expect(matterRows).toEqual([{ id: matterScopedId }]);
});

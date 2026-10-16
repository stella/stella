import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import { contacts } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { importContactRows } from "@/api/handlers/contacts/import-contacts";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { readExternalRefIds } from "@/api/lib/imports/upsert-by-external-id";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

/**
 * Re-running an import that carries external refs converges: the second run
 * updates the contacts the first created instead of adding duplicates, and a
 * ref only ever matches within the importing organization.
 */

let db: TestDatabase;

type Tenant = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  safeDb: SafeDb;
};

const createTenant = async (name: string): Promise<Tenant> => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  await db.insert(organization).values({
    id: organizationId,
    name,
    slug: `import-provenance-${organizationId}`,
    createdAt: new Date(),
  });
  await db.insert(user).values({
    id: userId,
    name,
    email: `${userId}@example.test`,
    emailVerified: true,
  });
  return {
    organizationId,
    userId,
    safeDb: asTestRaw<SafeDb>(createSafeDb(db, [], organizationId, userId)),
  };
};

type ImportRow = Parameters<
  typeof importContactRows
>[0]["body"]["rows"][number];

const runImport = async (
  tenant: Tenant,
  rows: ImportRow[],
  taxIdScheme: "none" | "br_cpf_cnpj" = "none",
) => {
  const outcome = await importContactRows({
    safeDb: tenant.safeDb,
    organizationId: tenant.organizationId,
    userId: tenant.userId,
    recordAuditEvent: async () => undefined,
    body: {
      importRequestId: createSafeId<"contactImportRequest">(),
      taxIdScheme,
      rows,
    },
  });
  if (Result.isError(outcome)) {
    return panic("Import transaction failed", { cause: outcome.error });
  }
  if (outcome.value.status !== "created") {
    return panic(`Expected a fresh import, got ${outcome.value.status}`);
  }
  return outcome.value.result.results;
};

const person = (
  displayName: string,
  external?: { source: string; id: string },
): ImportRow => ({
  id: createSafeId<"contact">(),
  type: "person",
  displayName,
  ...(external === undefined ? {} : { external }),
});

const storedContacts = async (organizationId: SafeId<"organization">) =>
  await db
    .select({
      id: contacts.id,
      displayName: contacts.displayName,
      notes: contacts.notes,
      externalSource: contacts.externalSource,
      externalId: contacts.externalId,
      importedAt: contacts.importedAt,
    })
    .from(contacts)
    .where(eq(contacts.organizationId, organizationId))
    .orderBy(contacts.externalId, contacts.id);

beforeAll(async () => {
  db = await getTestDb();
}, 300_000);
afterAll(releaseTestDb);

describe("contact import by external ref", () => {
  test("running the same import twice leaves the same contacts", async () => {
    const tenant = await createTenant("Re-run");
    const refs = [
      { source: "address-book", id: "C-1" },
      { source: "address-book", id: "C-2" },
    ];

    const first = await runImport(tenant, [
      person("Jana Nováková", refs[0]),
      person("Petr Svoboda", refs[1]),
    ]);
    expect(first.map(({ status }) => status)).toEqual(["created", "created"]);
    const afterFirst = await storedContacts(tenant.organizationId);

    // Fresh caller ids and one changed name: the refs, not the ids, decide.
    const second = await runImport(tenant, [
      person("Jana Nováková", refs[0]),
      person("Petr Svoboda-Dvořák", refs[1]),
    ]);
    expect(second.map(({ status }) => status)).toEqual(["updated", "updated"]);
    expect(
      second.map((row) => (row.status === "skipped" ? null : row.contactId)),
    ).toEqual(
      first.map((row) => (row.status === "skipped" ? null : row.contactId)),
    );

    const afterSecond = await storedContacts(tenant.organizationId);
    expect(afterSecond.map(({ id }) => id)).toEqual(
      afterFirst.map(({ id }) => id),
    );
    expect(afterSecond.map(({ displayName }) => displayName)).toEqual([
      "Jana Nováková",
      "Petr Svoboda-Dvořák",
    ]);
    for (const row of afterSecond) {
      expect(row.importedAt).toBeInstanceOf(Date);
    }

    // A third identical run is a fixed point.
    await runImport(tenant, [
      person("Jana Nováková", refs[0]),
      person("Petr Svoboda-Dvořák", refs[1]),
    ]);
    expect(
      (await storedContacts(tenant.organizationId)).map(
        ({ id, displayName, externalSource, externalId }) => ({
          id,
          displayName,
          externalSource,
          externalId,
        }),
      ),
    ).toEqual(
      afterSecond.map(({ id, displayName, externalSource, externalId }) => ({
        id,
        displayName,
        externalSource,
        externalId,
      })),
    );
  });

  test("a re-import keeps stella-side fields the import does not model", async () => {
    const tenant = await createTenant("Kept fields");
    const ref = { source: "address-book", id: "K-1" };
    const [created] = await runImport(tenant, [person("Eva Malá", ref)]);
    if (created?.status !== "created") {
      panic("Fixture contact was not created");
    }
    await db
      .update(contacts)
      .set({ color: "teal" })
      .where(eq(contacts.id, created.contactId));

    await runImport(tenant, [person("Eva Malá", ref)]);

    const [stored] = await db
      .select({ color: contacts.color })
      .from(contacts)
      .where(eq(contacts.id, created.contactId));
    expect(stored?.color).toBe("teal");
  });

  test("a ref matches only the importing organization's contacts", async () => {
    const first = await createTenant("Org A");
    const second = await createTenant("Org B");
    const ref = { source: "address-book", id: "SHARED-7" };

    const [inFirst] = await runImport(first, [person("Org A person", ref)]);
    const [inSecond] = await runImport(second, [person("Org B person", ref)]);
    expect(inFirst?.status).toBe("created");
    expect(inSecond?.status).toBe("created");
    if (inFirst?.status !== "created" || inSecond?.status !== "created") {
      panic("Both organizations must create their own contact");
    }
    expect(inSecond.contactId).not.toBe(inFirst.contactId);

    const [firstStored] = await storedContacts(first.organizationId);
    expect(firstStored?.displayName).toBe("Org A person");

    // The scoped read sees only the caller's organization, even when asked
    // under another organization's id.
    const crossRead = await first.safeDb(
      async (tx) =>
        await readExternalRefIds({
          tx,
          table: contacts,
          organizationId: second.organizationId,
          refs: [ref],
        }),
    );
    expect(Result.isOk(crossRead) && crossRead.value.size).toBe(0);
  });

  test("a new ref whose id another organization holds is skipped, not the batch", async () => {
    const first = await createTenant("Id holder");
    const second = await createTenant("Id reuser");
    const [held] = await runImport(first, [person("Held contact")]);
    if (held?.status !== "created") {
      panic("The first organization must create its contact");
    }

    const results = await runImport(second, [
      {
        ...person("Reused id", { source: "address-book", id: "X-1" }),
        id: held.contactId,
      },
      person("Valid new row", { source: "address-book", id: "X-2" }),
    ]);
    expect(results.at(0)).toMatchObject({
      status: "skipped",
      reason: "duplicate_contact_id",
    });
    expect(results.at(1)?.status).toBe("created");

    const stored = await storedContacts(second.organizationId);
    expect(stored.map(({ displayName }) => displayName)).toEqual([
      "Valid new row",
    ]);
    const [firstStored] = await storedContacts(first.organizationId);
    expect(firstStored).toMatchObject({
      id: held.contactId,
      displayName: "Held contact",
      externalSource: null,
      externalId: null,
    });
  });

  test("a ref repeated within one batch is written once", async () => {
    const tenant = await createTenant("Batch duplicate");
    const ref = { source: "address-book", id: "D-1" };
    const results = await runImport(tenant, [
      person("First", ref),
      person("Second", ref),
    ]);
    expect(results.map(({ status }) => status)).toEqual(["created", "skipped"]);
    expect(results.at(1)).toMatchObject({ reason: "duplicate_external_ref" });
    expect(await storedContacts(tenant.organizationId)).toHaveLength(1);
  });

  test("a re-imported ref updates its own contact whatever id the row carries", async () => {
    const tenant = await createTenant("Ref with another id");
    const ref = { source: "address-book", id: "R-1" };
    const [byRef, plain] = await runImport(tenant, [
      person("By ref", ref),
      person("Plain"),
    ]);
    if (byRef?.status !== "created" || plain?.status !== "created") {
      panic("Both seed contacts must be created");
    }

    const results = await runImport(tenant, [
      { ...person("By ref, renamed", ref), id: plain.contactId },
      person("New"),
    ]);
    expect(results.map(({ status }) => status)).toEqual(["updated", "created"]);
    expect(results.at(0)).toMatchObject({ contactId: byRef.contactId });

    const stored = await storedContacts(tenant.organizationId);
    expect(stored).toHaveLength(3);
    expect(stored.find(({ id }) => id === byRef.contactId)?.displayName).toBe(
      "By ref, renamed",
    );
    expect(stored.find(({ id }) => id === plain.contactId)?.displayName).toBe(
      "Plain",
    );
  });

  test("an updated contact's own tax id is not a duplicate", async () => {
    const tenant = await createTenant("Tax id");
    const ref = { source: "address-book", id: "T-1" };
    const row = (displayName: string): ImportRow => ({
      ...person(displayName, ref),
      taxId: "123.456.789-09",
    });

    await runImport(tenant, [row("Rafael Souza")], "br_cpf_cnpj");
    const [rerun] = await runImport(
      tenant,
      [row("Rafael de Souza")],
      "br_cpf_cnpj",
    );
    expect(rerun?.status).toBe("updated");

    // A different contact with the same tax id is still refused.
    const [other] = await runImport(
      tenant,
      [
        {
          ...person("Someone else", { source: "address-book", id: "T-2" }),
          taxId: "123.456.789-09",
        },
      ],
      "br_cpf_cnpj",
    );
    expect(other).toMatchObject({
      status: "skipped",
      reason: "duplicate_tax_id",
    });
  });

  test("rows without a ref keep creating, as before", async () => {
    const tenant = await createTenant("No ref");
    await runImport(tenant, [person("Plain row")]);
    await runImport(tenant, [person("Plain row")]);
    expect(await storedContacts(tenant.organizationId)).toHaveLength(2);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { rejectionOf } from "@stll/property-testing/rejection";

import { organization, user } from "@/api/db/auth-schema";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import ledgerData from "./tenant-scoped-references.json";

/**
 * PostgreSQL checks a foreign key without row security: the referenced row is
 * looked up as the table owner, so a policy that hides another tenant's row
 * from the application role does not stop a reference to it. Only a reference
 * that carries the tenant column refuses it. These cases write through the
 * application role, inside organization A's session, a reference to a row of
 * organization B that the same session cannot read.
 */

const TIMEOUT = 120_000;
const ORG_A = mintAuthProviderId<"organization">();
const ORG_B = mintAuthProviderId<"organization">();
const AUTHOR = mintAuthProviderId<"user">();

const CONTACT_A = Bun.randomUUIDv7();
const CONTACT_B = Bun.randomUUIDv7();
const CLAUSE_B = Bun.randomUUIDv7();
const CATEGORY_B = Bun.randomUUIDv7();

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

/** Run `statement` as the application role inside organization A's session. */
const asOrganizationA = async (
  statement: SQL,
  count: "rows" | "affected" = "affected",
): Promise<number> =>
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE stella`);
    await tx.execute(
      sql`SELECT set_config('app.organization_id', ${ORG_A}, true)`,
    );
    const result = await tx.execute(statement);
    return count === "rows" ? result.rows.length : (result.affectedRows ?? 0);
  });

const isLedgered = (reference: string): boolean =>
  Object.hasOwn(ledgerData.references, reference);

const foreignKeyRefusal = async (write: Promise<number>) => {
  const error = await rejectionOf(write);
  const cause =
    error instanceof Error && error.cause !== undefined ? error.cause : error;
  return cause instanceof Error ? cause.message : String(cause);
};

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  const createdAt = new Date("2026-10-22T12:00:00Z");
  await db.insert(organization).values([
    { id: ORG_A, name: "Tenant A", slug: ORG_A, createdAt },
    { id: ORG_B, name: "Tenant B", slug: ORG_B, createdAt },
  ]);
  await db.insert(user).values({
    id: AUTHOR,
    name: "Synthetic Author",
    email: "author@example.test",
    emailVerified: false,
    createdAt,
    updatedAt: createdAt,
  });
  await db.execute(sql`
    INSERT INTO contacts (id, organization_id, type, display_name) VALUES
      (${CONTACT_A}, ${ORG_A}, 'person', 'Contact A'),
      (${CONTACT_B}, ${ORG_B}, 'person', 'Contact B')
  `);
  await db.execute(sql`
    INSERT INTO clauses (id, organization_id, title, body, created_by)
    VALUES (${CLAUSE_B}, ${ORG_B}, 'Clause B', '{}'::jsonb, ${AUTHOR})
  `);
  await db.execute(sql`
    INSERT INTO clause_categories (id, organization_id, name)
    VALUES (${CATEGORY_B}, ${ORG_B}, 'Category B')
  `);
}, TIMEOUT);

afterAll(async () => {
  await client.close();
});

describe("a reference between tenant-owned rows stays inside one tenant", () => {
  test(
    "organization A's session cannot read organization B's rows",
    async () => {
      expect(
        await asOrganizationA(
          sql`
          SELECT id FROM contacts WHERE id = ${CONTACT_B}
          UNION ALL SELECT id FROM clauses WHERE id = ${CLAUSE_B}
          UNION ALL SELECT id FROM clause_categories WHERE id = ${CATEGORY_B}
        `,
          "rows",
        ),
      ).toBe(0);
    },
    TIMEOUT,
  );

  test(
    "a reference bound to the organization refuses another organization's contact",
    async () => {
      expect(
        await foreignKeyRefusal(
          asOrganizationA(sql`
            INSERT INTO contact_relationships
              (id, organization_id, person_id, related_contact_id, relationship_type)
            VALUES
              (${Bun.randomUUIDv7()}, ${ORG_A}, ${CONTACT_A}, ${CONTACT_B}, 'employee')
          `),
        ),
      ).toContain("contact_relationships_related_contact_fk");
    },
    TIMEOUT,
  );

  test(
    "a reference that was composite before this change refuses another organization's clause",
    async () => {
      expect(
        await foreignKeyRefusal(
          asOrganizationA(sql`
            INSERT INTO clause_variants (id, organization_id, clause_id, label, body)
            VALUES (${Bun.randomUUIDv7()}, ${ORG_A}, ${CLAUSE_B}, 'Variant', '{}'::jsonb)
          `),
        ),
      ).toContain("violates foreign key constraint");
    },
    TIMEOUT,
  );

  test(
    "an id-only reference still in the ledger accepts another organization's row",
    async () => {
      // Recorded, not endorsed: once the clause-category family is converted
      // and its ledger entry removed, this case expects the refusal instead.
      const reference = "clauses(category_id) -> clause_categories(id)";
      const write = asOrganizationA(sql`
        INSERT INTO clauses (id, organization_id, category_id, title, body, created_by)
        VALUES (${Bun.randomUUIDv7()}, ${ORG_A}, ${CATEGORY_B}, 'Clause A', '{}'::jsonb, ${AUTHOR})
      `);
      if (isLedgered(reference)) {
        expect(await write).toBe(1);
      } else {
        expect(await foreignKeyRefusal(write)).toContain(
          "violates foreign key constraint",
        );
      }
    },
    TIMEOUT,
  );
});

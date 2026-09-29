import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";

import { organization } from "@/api/db/auth-schema";
import { contacts } from "@/api/db/schema";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * Migration `20261003120500_contact_person_details`: a person's partial date
 * of birth and nationality codes, and the CHECKs that keep them well shaped.
 * A partial date only ever drops trailing parts (year, year-month, full date),
 * a day exists in its month, and each nationality element is exactly one
 * upper-case two-letter code. The test database is built from the Drizzle
 * schema; the CHECK parity test below re-applies the migration's own
 * constraint statements and holds them equal to the schema's.
 */

const MIGRATION_SQL = readFileSync(
  new URL(
    "../../drizzle/20261003120500_contact_person_details/migration.sql",
    import.meta.url,
  ),
  "utf-8",
);

const ORGANIZATION_ID = mintAuthProviderId<"organization">();

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const rejection = async (write: Promise<unknown>): Promise<string> =>
  await write.then(
    () => panic("expected the database to refuse the write"),
    (error: unknown) => {
      const cause: unknown =
        error instanceof Error && error.cause !== undefined
          ? error.cause
          : error;
      return cause instanceof Error ? cause.message : String(cause);
    },
  );

type PersonDetails = Pick<
  typeof contacts.$inferInsert,
  "dateOfBirthYear" | "dateOfBirthMonth" | "dateOfBirthDay" | "nationalityCodes"
>;

const baseRow = {
  organizationId: ORGANIZATION_ID,
  type: "person",
  displayName: "Jana Nováková",
} as const satisfies typeof contacts.$inferInsert;

const insertPerson = (details: PersonDetails) =>
  db.insert(contacts).values({ ...baseRow, ...details });

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(organization).values({
    id: ORGANIZATION_ID,
    name: "Contact person details",
    slug: ORGANIZATION_ID,
    createdAt: new Date(),
  });
});

afterAll(async () => {
  await client.close();
});

describe("contact person details", () => {
  test.each<[string, PersonDetails]>([
    ["no date of birth and no nationality", { nationalityCodes: [] }],
    ["a year alone", { dateOfBirthYear: 1980 }],
    ["a year and month", { dateOfBirthYear: 1980, dateOfBirthMonth: 5 }],
    [
      "29 February of a leap year",
      { dateOfBirthYear: 1984, dateOfBirthMonth: 2, dateOfBirthDay: 29 },
    ],
    ["two nationality codes", { nationalityCodes: ["US", "GB"] }],
  ])("a person with %s is accepted", async (_label, details) => {
    await insertPerson(details);
  });

  test.each<[string, PersonDetails]>([
    [
      "29 February of a common year",
      { dateOfBirthYear: 1981, dateOfBirthMonth: 2, dateOfBirthDay: 29 },
    ],
    ["a month without a year", { dateOfBirthMonth: 5 }],
    ["a day without a month", { dateOfBirthYear: 2020, dateOfBirthDay: 2 }],
    ["a day alone", { dateOfBirthDay: 2 }],
  ])("a person with %s is refused", async (_label, details) => {
    expect(await rejection(insertPerson(details))).toContain(
      'violates check constraint "contacts_date_of_birth_check"',
    );
  });

  test.each<[string, string[]]>([
    ["two codes in one element", ["US,GB"]],
    ["codes split across elements", ["USG", "B"]],
    ["a lower-case code", ["us"]],
  ])("a nationality list with %s is refused", async (_label, codes) => {
    expect(
      await rejection(insertPerson({ nationalityCodes: codes })),
    ).toContain('violates check constraint "contacts_nationality_codes_check"');
  });

  test("an organization contact without person details is accepted", async () => {
    await db.insert(contacts).values({
      ...baseRow,
      type: "organization",
      organizationName: "Acme s.r.o.",
      displayName: "Acme s.r.o.",
    });
  });

  test.each<[string, PersonDetails]>([
    ["a birth year", { dateOfBirthYear: 1980 }],
    ["a nationality code", { nationalityCodes: ["CZ"] }],
  ])("an organization contact with %s is refused", async (_label, details) => {
    const message = await rejection(
      db.insert(contacts).values({
        ...baseRow,
        ...details,
        type: "organization",
        organizationName: "Acme s.r.o.",
        displayName: "Acme s.r.o.",
      }),
    );
    expect(message).toContain(
      'violates check constraint "contacts_person_details_check"',
    );
  });

  test("the migration's CHECKs are the schema's CHECKs", async () => {
    const constraintNames = [
      "contacts_person_details_check",
      "contacts_date_of_birth_check",
      "contacts_nationality_codes_check",
    ];
    const definitions = async () =>
      Object.fromEntries(
        (
          await db.execute<{ name: string; definition: string }>(sql`
            SELECT conname AS name, pg_get_constraintdef(oid) AS definition
            FROM pg_constraint
            WHERE conname IN (${sql.join(
              constraintNames.map((name) => sql`${name}`),
              sql`, `,
            )})
          `)
        ).rows.map(({ name, definition }) => [name, definition]),
      );
    const fromSchema = await definitions();

    const constraintStatements = MIGRATION_SQL.split("--> statement-breakpoint")
      .map((statement) =>
        statement
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("--"))
          .join("\n")
          .trim(),
      )
      .filter((statement) =>
        /^ALTER TABLE "contacts"\s+ADD CONSTRAINT/u.test(statement),
      );
    expect(constraintStatements).toHaveLength(constraintNames.length);
    for (const name of constraintNames) {
      await db.execute(
        sql.raw(`ALTER TABLE "contacts" DROP CONSTRAINT "${name}"`),
      );
    }
    for (const statement of constraintStatements) {
      await db.execute(sql.raw(statement));
    }
    // The migration adds them NOT VALID; validating also re-checks every row
    // the tests above accepted.
    for (const name of constraintNames) {
      await db.execute(
        sql.raw(`ALTER TABLE "contacts" VALIDATE CONSTRAINT "${name}"`),
      );
    }

    expect(Object.keys(fromSchema).toSorted()).toEqual(
      constraintNames.toSorted(),
    );
    expect(await definitions()).toEqual(fromSchema);
  });
});

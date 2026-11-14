import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  classifyContactsAccessModule,
  contactRelationNames,
  CONTACTS_OWNER_SCOPE_FILE,
  CONTACTS_SIGNAL,
} from "./contacts-owner-scope-census";
import type { ContactsAccessFinding } from "./contacts-owner-scope-census";
import allowlist from "./contacts-owner-scope-census.allowlist.json";
import { evaluateMatterAccessCensus } from "./matter-access-census";

const repoRoot = path.resolve(import.meta.dir, "../../../../..");

const contactRelations = contactRelationNames(
  readFileSync(
    path.join(repoRoot, "apps/api/src/db/schema/relations.ts"),
    "utf-8",
  ),
);

const isProductionSource = (file: string) =>
  !file.endsWith(".test.ts") &&
  !file.includes("/tests/") &&
  !file.includes("/__fixtures__/") &&
  !file.endsWith(".fixture.ts");

const collectFindings = (): ContactsAccessFinding[] => {
  const findings: ContactsAccessFinding[] = [];
  for (const pattern of ["apps/api/src/**/*.ts", "apps/api/scripts/**/*.ts"]) {
    for (const file of new Glob(pattern).scanSync({ cwd: repoRoot })) {
      if (!isProductionSource(file)) {
        continue;
      }
      const source = readFileSync(path.join(repoRoot, file), "utf-8");
      findings.push(
        ...classifyContactsAccessModule(file, source, { contactRelations }),
      );
    }
  }
  return findings;
};

const FIXTURE_FILE = "apps/api/src/lib/contacts-owner-scope.fixture.ts";
const FIXTURE_KEY = `${FIXTURE_FILE}::${CONTACTS_SIGNAL}`;

const classifyFixture = (source: string) =>
  classifyContactsAccessModule(FIXTURE_FILE, source, { contactRelations });

/** The sites a fixture module reports, or none. */
const fixtureSites = (source: string) => classifyFixture(source).at(0)?.sites;

const IMPORTS = `
import { contacts as people } from "@/api/db/schema";
import { rootDb } from "@/api/db/root";
import { withOwnerOrganizationScope } from "@/api/lib/db/owner-organization-scope";
`;

const OWNER_MODULE_FIXTURE = `${IMPORTS}
export const scopedRead = async (organizationId: string) =>
  await withOwnerOrganizationScope(rootDb, organizationId, async (tx) =>
    await tx.select().from(people),
  );

export const unscopedRead = async () => await rootDb.select().from(people);

export const unscopedRelational = async () =>
  await rootDb.query.contacts.findMany();

export const unscopedSql = async () =>
  await rootDb.execute(sql\`UPDATE public.contacts SET tax_id = NULL\`);

export const columnOnly = (row: { id: string }) => people.id === row.id;
`;

describe("contacts owner-scope census", () => {
  const findings = collectFindings();

  test("every contacts read or write outside the owner scope is allowlisted with its handle", () => {
    expect(evaluateMatterAccessCensus(findings, allowlist)).toEqual({
      violations: [],
      stale: [],
    });
  });

  test("the census reads the relation names the schema declares into contacts", () => {
    expect([...contactRelations].toSorted()).toEqual([
      "client",
      "contact",
      "person",
      "relatedContact",
    ]);
  });

  test("the owner module itself is no finding, and every owner scope call is pinned", () => {
    expect(
      findings.filter(({ file }) => file === CONTACTS_OWNER_SCOPE_FILE),
    ).toEqual([]);
    for (const file of [
      "apps/api/src/lib/search/projection-repair-queue.ts",
      "apps/api/src/lib/review-organization/reset.ts",
    ]) {
      const sites =
        findings.find((finding) => finding.file === file)?.sites ?? {};
      expect(
        Object.keys(sites).some((site) =>
          site.includes("#withOwnerOrganizationScope("),
        ),
      ).toBe(true);
    }
  });

  test("a negative fixture: unscoped owner reads and writes are findings, the scoped one only pins its call", () => {
    const fixtureFindings = classifyFixture(OWNER_MODULE_FIXTURE);
    expect(fixtureFindings).toEqual([
      {
        file: FIXTURE_FILE,
        signal: CONTACTS_SIGNAL,
        screened: false,
        sites: {
          "scopedRead#withOwnerOrganizationScope(organizationId)": 1,
          unscopedRead: 1,
          unscopedRelational: 1,
          unscopedSql: 1,
        },
      },
    ]);
    // Deny by default: without an allowlist entry each one fails the census,
    // and an entry pins the sites it admits.
    expect(evaluateMatterAccessCensus(fixtureFindings, {})).toEqual({
      violations: [FIXTURE_KEY],
      stale: [],
    });
    expect(
      evaluateMatterAccessCensus(fixtureFindings, {
        [FIXTURE_KEY]: {
          reason: "fixture",
          sites: {
            "scopedRead#withOwnerOrganizationScope(organizationId)": 1,
            unscopedRead: 1,
            unscopedRelational: 1,
          },
        },
      }),
    ).toEqual({
      violations: [`${FIXTURE_KEY} @ unscopedSql: 1 sites, allowed 0`],
      stale: [],
    });
  });

  test("a new owner scope call, or one naming another organization, is a new pinned site", () => {
    expect(
      fixtureSites(`${IMPORTS}
export const one = async (row: { organizationId: string }) =>
  await withOwnerOrganizationScope(rootDb, row.organizationId, async (tx) => tx);
export const two = async (target: { organizationId: string }) =>
  await withOwnerOrganizationScope(rootDb, target.organizationId, async (tx) => tx);
`),
    ).toEqual({
      "one#withOwnerOrganizationScope(row.organizationId)": 1,
      "two#withOwnerOrganizationScope(target.organizationId)": 1,
    });
  });

  test("an owner handle used inside the scope callback is still a finding", () => {
    expect(
      fixtureSites(`${IMPORTS}
export const mixed = async (organizationId: string) =>
  await withOwnerOrganizationScope(rootDb, organizationId, async (tx) => {
    await tx.select().from(people);
    await tx.execute(sql\`DELETE FROM contacts WHERE id = \${organizationId}\`);
    await rootDb.select().from(people);
    await tx.transaction(async () => await rootDb.query.contacts.findMany());
  });
`),
    ).toEqual({
      "mixed#withOwnerOrganizationScope(organizationId)": 1,
      mixed: 2,
    });
  });

  test("an alias of the owner scope is pinned like the owner scope", () => {
    expect(
      fixtureSites(`${IMPORTS}
const scoped = withOwnerOrganizationScope;
export const aliased = async (other: { organizationId: string }) =>
  await scoped(rootDb, other.organizationId, async (tx) => tx);
`),
    ).toEqual({
      "aliased#withOwnerOrganizationScope(other.organizationId)": 1,
    });
  });

  test("a callback that declares its transaction name again is not screened", () => {
    expect(
      fixtureSites(`${IMPORTS}
export const shadowed = async (organizationId: string) =>
  await withOwnerOrganizationScope(rootDb, organizationId, async (tx) => {
    {
      const tx = rootDb;
      await tx.select().from(people);
    }
  });
`),
    ).toEqual({
      "shadowed#withOwnerOrganizationScope(organizationId)": 1,
      shadowed: 1,
    });
  });

  test("a relation-only read under a quoted key is a finding", () => {
    expect(
      fixtureSites(`
export const matter = async (db: { query: { workspaces: { findFirst: (q: unknown) => unknown } } }) =>
  await db.query.workspaces.findFirst({ "with": { "client": true } });
`),
    ).toEqual({ "matter.with": 1 });
  });

  test("a relation followed into contacts from another table is a finding", () => {
    expect(
      fixtureSites(`${IMPORTS}
export const matters = async () =>
  await rootDb.query.workspaces.findMany({
    with: { client: true, members: true, contact: false },
  });
`),
    ).toEqual({ "matters.with": 1 });
  });

  test("a template that interpolates a contacts-name constant is a finding", () => {
    expect(
      fixtureSites(`
const TABLE = "contacts";
export const move = async (tx: { query: (text: string) => unknown }) =>
  await tx.query(\`UPDATE public."\${TABLE}" SET vat_id = tax_id\`);
export const label = (other: string) => \`table \${TABLE} and \${other}\`;
`),
    ).toEqual({ TABLE: 1, move: 1 });
  });

  test("USING, ONLY, TRUNCATE, LOCK and COPY forms name the table", () => {
    expect(
      fixtureSites(`
export const forms = [
  "DELETE FROM matters USING contacts WHERE matters.client_id = contacts.id",
  "UPDATE ONLY public.contacts SET tax_id = NULL",
  "TRUNCATE TABLE contacts",
  "LOCK TABLE ONLY \\"contacts\\" IN SHARE MODE",
  "COPY contacts TO STDOUT",
  "SELECT 1 FROM contacts_archive",
];
`),
    ).toEqual({ forms: 5 });
  });
});

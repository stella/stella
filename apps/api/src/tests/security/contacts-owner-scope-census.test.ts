import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  classifyContactsAccessModule,
  CONTACTS_OWNER_SCOPE_FILE,
  CONTACTS_SIGNAL,
} from "./contacts-owner-scope-census";
import type { ContactsAccessFinding } from "./contacts-owner-scope-census";
import allowlist from "./contacts-owner-scope-census.allowlist.json";
import { evaluateMatterAccessCensus } from "./matter-access-census";

const repoRoot = path.resolve(import.meta.dir, "../../../../..");

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
      findings.push(...classifyContactsAccessModule(file, source));
    }
  }
  return findings;
};

const OWNER_MODULE_FIXTURE = `
import { contacts as people } from "@/api/db/schema";
import { rootDb } from "@/api/db/root";
import { withOwnerOrganizationScope } from "@/api/lib/db/owner-organization-scope";

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

  test("the census reaches the owner-scoped callers it screens", () => {
    // These modules reach contacts on the owner connection only through the
    // owner scope, so none of their sites is a finding.
    for (const file of [
      "apps/api/src/lib/search/projection-repair-queue.ts",
      "apps/api/src/lib/review-organization/reset.ts",
    ]) {
      const source = readFileSync(path.join(repoRoot, file), "utf-8");
      expect(source).toContain("withOwnerOrganizationScope(");
    }
    expect(
      findings.filter(({ file }) => file === CONTACTS_OWNER_SCOPE_FILE),
    ).toEqual([]);
  });

  test("a negative fixture: unscoped owner reads and writes are findings, the scoped one is not", () => {
    const fixtureFindings = classifyContactsAccessModule(
      "apps/api/src/lib/contacts-owner-scope.fixture.ts",
      OWNER_MODULE_FIXTURE,
    );
    expect(fixtureFindings).toEqual([
      {
        file: "apps/api/src/lib/contacts-owner-scope.fixture.ts",
        signal: CONTACTS_SIGNAL,
        screened: false,
        sites: {
          unscopedRead: 1,
          unscopedRelational: 1,
          unscopedSql: 1,
        },
      },
    ]);
    // Deny by default: without an allowlist entry each one fails the census,
    // and an entry pins the sites it admits.
    expect(evaluateMatterAccessCensus(fixtureFindings, {})).toEqual({
      violations: [
        `apps/api/src/lib/contacts-owner-scope.fixture.ts::${CONTACTS_SIGNAL}`,
      ],
      stale: [],
    });
    expect(
      evaluateMatterAccessCensus(fixtureFindings, {
        [`apps/api/src/lib/contacts-owner-scope.fixture.ts::${CONTACTS_SIGNAL}`]:
          {
            reason: "fixture",
            sites: { unscopedRead: 1, unscopedRelational: 1 },
          },
      }),
    ).toEqual({
      violations: [
        `apps/api/src/lib/contacts-owner-scope.fixture.ts::${CONTACTS_SIGNAL} @ unscopedSql: 1 sites, allowed 0`,
      ],
      stale: [],
    });
  });
});

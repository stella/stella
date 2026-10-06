import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import { caseLawProvisionCitations } from "@/api/db/schema";

import { PROVISION_CITATION_CHECK_STEP } from "./citation-checks";
import type { ProvisionBackfillSession } from "./step";

const CONSTRAINT_NAMES = getTableConfig(caseLawProvisionCitations).checks.map(
  ({ name }) => name,
);

/** A catalog whose constraints become valid as the connection validates them. */
const fakeConnection = (
  validated: Set<string>,
  statements: string[],
): ProvisionBackfillSession => ({
  setTransactionBudget: async (budget) => {
    statements.push(`budget ${JSON.stringify(budget)}`);
  },
  execute: async (query) => {
    statements.push(query);
    const validatedName = /VALIDATE CONSTRAINT "([a-z_]+)"/u.exec(query)?.[1];
    if (validatedName !== undefined) {
      validated.add(validatedName);
    }
  },
  query: async () =>
    CONSTRAINT_NAMES.map((name) => ({
      name,
      isValidated: validated.has(name),
    })),
});

describe("provision citation CHECK validation", () => {
  test("validates one pending constraint per unit, each in its own bounded transaction", async () => {
    const statements: string[] = [];
    const pendingConstraints = CONSTRAINT_NAMES.filter(
      (_, index) => index % 2 === 0,
    );
    const firstPending =
      pendingConstraints.at(0) ??
      panic("Case-law provision table has no owned CHECKs");
    const nextPending =
      pendingConstraints.at(1) ??
      panic("Case-law provision table needs multiple owned CHECKs");
    const validated = new Set(
      CONSTRAINT_NAMES.filter((_, index) => index % 2 !== 0),
    );
    const connection = fakeConnection(validated, statements);

    (await PROVISION_CITATION_CHECK_STEP.advance(connection)).unwrap();

    expect(statements.slice(0, 4)).toEqual([
      "BEGIN",
      'budget {"lockTimeout":10000,"statementTimeout":1500000}',
      `ALTER TABLE public."case_law_provision_citations" VALIDATE CONSTRAINT "${firstPending}"`,
      "COMMIT",
    ]);
    expect(
      await PROVISION_CITATION_CHECK_STEP.readCompletion(connection),
    ).toEqual({
      reason: `constraint ${nextPending} is not validated`,
      type: "incomplete",
    });

    for (const constraintName of pendingConstraints.slice(1)) {
      (await PROVISION_CITATION_CHECK_STEP.advance(connection)).unwrap();
      expect(statements.at(-2)).toContain(
        `VALIDATE CONSTRAINT "${constraintName}"`,
      );
    }
    expect(
      await PROVISION_CITATION_CHECK_STEP.readCompletion(connection),
    ).toEqual({ type: "complete" });
    expect(
      statements.filter((statement) => statement.includes("VALIDATE")),
    ).toHaveLength(pendingConstraints.length);
  });
});

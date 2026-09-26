import { describe, expect, test } from "bun:test";

import { PROVISION_CITATION_CHECK_STEP } from "./citation-checks";
import type { ProvisionBackfillSession } from "./step";

const CONSTRAINT_NAMES = [
  "provision_citations_span_role_values",
  "provision_citations_selection_values",
  "provision_citations_target_status_values",
  "provision_citations_print_segment_shape",
  "provision_citations_name_segment_shape",
] as const;

/** A catalog whose constraints become valid as the connection validates them. */
const fakeConnection = (
  validated: Set<string>,
  statements: string[],
): ProvisionBackfillSession => ({
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
    const connection = fakeConnection(
      new Set(CONSTRAINT_NAMES.slice(0, 2)),
      statements,
    );

    await PROVISION_CITATION_CHECK_STEP.advance(connection);

    expect(statements).toEqual([
      "BEGIN",
      "SET LOCAL lock_timeout = '10s'",
      "SET LOCAL statement_timeout = '25min'",
      'ALTER TABLE public."case_law_provision_citations" VALIDATE CONSTRAINT "provision_citations_target_status_values"',
      "COMMIT",
    ]);
    expect(
      await PROVISION_CITATION_CHECK_STEP.readCompletion(connection),
    ).toEqual({
      reason:
        "constraint provision_citations_print_segment_shape is not validated",
      type: "incomplete",
    });

    await PROVISION_CITATION_CHECK_STEP.advance(connection);
    await PROVISION_CITATION_CHECK_STEP.advance(connection);
    expect(
      await PROVISION_CITATION_CHECK_STEP.readCompletion(connection),
    ).toEqual({ type: "complete" });
    expect(
      statements.filter((statement) => statement.includes("VALIDATE")),
    ).toHaveLength(3);
  });
});

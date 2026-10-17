import { describe, expect, test } from "bun:test";

import {
  judgeParity,
  proposedStatements,
} from "./check-migrated-schema-parity";
import type { RetiredSchema } from "./check-migrated-schema-parity";

const NONE: RetiredSchema = {
  tables: [],
  columns: [],
  policies: [],
  constraints: [],
  indexes: [],
};

const RETIRED: RetiredSchema = {
  tables: ["drafts"],
  columns: [{ table: "documents", column: "legacy" }],
  policies: [{ table: "drafts", name: "drafts_workspace" }],
  constraints: [{ table: "documents", name: "documents_legacy_check" }],
  indexes: ["documents_legacy_idx"],
};

const explain = (statements: string[]) =>
  `Using 'bun' driver for database querying\n[✓] Pulling schema from database...\n\n--- Generated migration statements ---\n${statements.join("\n")}\n`;

const RETIREMENT_STATEMENTS = [
  'DROP POLICY "drafts_workspace" ON "drafts";',
  'DROP TABLE "drafts";',
  'ALTER TABLE "documents" DROP CONSTRAINT "documents_legacy_check";',
  'DROP INDEX "documents_legacy_idx";',
  'ALTER TABLE "documents" DROP COLUMN "legacy";',
];

describe("judgeParity", () => {
  test("no changes and nothing retired is a match", () => {
    expect(
      judgeParity(proposedStatements("[i] No changes detected"), NONE),
    ).toEqual({ type: "match" });
  });

  test("accepts exactly the drops the retired objects explain", () => {
    expect(
      judgeParity(proposedStatements(explain(RETIREMENT_STATEMENTS)), RETIRED),
    ).toEqual({ type: "match" });
  });

  test("rejects a difference no retirement explains", () => {
    expect(
      judgeParity(
        proposedStatements(
          explain([
            ...RETIREMENT_STATEMENTS,
            'ALTER TABLE "documents" DROP COLUMN "title";',
          ]),
        ),
        RETIRED,
      ),
    ).toEqual({
      type: "mismatch",
      unexplained: ['ALTER TABLE "documents" DROP COLUMN "title";'],
      stillDeclared: [],
    });
  });

  test("rejects a retired object schema.ts still declares", () => {
    expect(
      judgeParity(proposedStatements("[i] No changes detected"), RETIRED),
    ).toEqual({
      type: "mismatch",
      unexplained: [],
      stillDeclared: [
        'DROP TABLE "drafts";',
        'ALTER TABLE "documents" DROP COLUMN "legacy";',
      ],
    });
  });

  test("output with neither verdict cannot be judged", () => {
    expect(
      judgeParity(proposedStatements("Error: connect ECONNREFUSED"), NONE),
    ).toEqual({
      type: "unparsed",
    });
  });
});

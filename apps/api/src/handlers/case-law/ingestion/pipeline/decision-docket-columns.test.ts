import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import { decisionDocketColumns } from "@/api/handlers/case-law/ingestion/pipeline/decision-docket-columns";

const apiRoot = path.resolve(import.meta.dir, "../../../../..");
const BUILDER_FILE =
  "src/handlers/case-law/ingestion/pipeline/decision-docket-columns.ts";
const SCHEMA_DIR = "src/db/schema/";

/**
 * Raw SQL that sets a decision's reference without keying its case file. Each
 * must say why the key needs no write of its own.
 */
const RAW_SQL_EXEMPTIONS = {
  "src/scripts/seed-migration-rehearsal-plan.ts":
    "synthetic rows for a migration rehearsal; their key stays unset, as on rows no write has keyed yet",
  "src/tests/security/public-law-search-census.ts":
    "fixture rows for a reader-role census that never reads the case-file key",
} as const satisfies Record<string, string>;

const sourceFiles = (): string[] =>
  ["src", "scripts"].flatMap((directory) =>
    [...new Bun.Glob(`${directory}/**/*.ts`).scanSync({ cwd: apiRoot })].filter(
      (file) =>
        !file.endsWith(".test.ts") &&
        !file.endsWith(".d.ts") &&
        !file.includes("/node_modules/"),
    ),
  );

const readSource = (file: string): string =>
  readFileSync(path.join(apiRoot, file), "utf-8");

/**
 * A property that names a column rather than writing one: a projection flag
 * (`caseNumber: true`), a column type tag (`caseNumber: "text"`), or the
 * column itself in a select (`caseNumber: caseLawDecisions.caseNumber`).
 */
const namesColumn = (initializer: ts.Expression): boolean =>
  initializer.kind === ts.SyntaxKind.TrueKeyword ||
  ts.isStringLiteral(initializer) ||
  (ts.isPropertyAccessExpression(initializer) &&
    ts.isIdentifier(initializer.expression) &&
    initializer.expression.text === "caseLawDecisions");

/** The properties a literal assigns a value to. */
const writtenPropertyNames = (
  literal: ts.ObjectLiteralExpression,
): Set<string> =>
  new Set(
    literal.properties.flatMap((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return [property.name.text];
      }
      return ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        !namesColumn(property.initializer)
        ? [property.name.text]
        : [];
    }),
  );

/** Object literals that state a decision's reference with its citation key. */
const referenceLiterals = (file: string, text: string): string[] => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const names = writtenPropertyNames(node);
      if (names.has("caseNumber") && names.has("citationKey")) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        found.push(`${file}:${String(line + 1)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

/** Statements that write `case_number` on a decision row. */
const CASE_NUMBER_WRITE_RE =
  /(?:\bUPDATE\s+"?case_law_decisions"?\b[^;]*?\bSET\b[^;]*?\bcase_number\s*=)|(?:\bINSERT\s+INTO\s+"?case_law_decisions"?\s*\([^)]*\bcase_number\b)/isu;

describe("writers of a decision's reference", () => {
  test("state it only through the docket columns builder", () => {
    const literals = sourceFiles()
      // The table's own column declarations name both and write neither.
      .filter((file) => file !== BUILDER_FILE && !file.startsWith(SCHEMA_DIR))
      .flatMap((file) => referenceLiterals(file, readSource(file)));
    expect(literals).toEqual([]);
  });

  test("raw SQL that sets case_number also sets the case-file key", () => {
    const unkeyed = sourceFiles().filter((file) => {
      const text = readSource(file);
      return (
        CASE_NUMBER_WRITE_RE.test(text) && !text.includes("docket_family_key")
      );
    });
    expect(unkeyed.toSorted()).toEqual(
      Object.keys(RAW_SQL_EXEMPTIONS).toSorted(),
    );
  });

  test("the builder keys a docket's case file and nothing else", () => {
    expect(
      decisionDocketColumns({
        caseNumber: "4 As 50/2012 - 33",
        caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        country: "CZE",
      }),
    ).toEqual({
      caseNumber: "4 As 50/2012 - 33",
      caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      citationKey: "4 as 50/2012-33",
      docketFamilyKey: "4as50/2012",
    });
    expect(
      decisionDocketColumns({
        caseNumber: "590 U.S. 1",
        caseNumberType: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        country: "USA",
      }).docketFamilyKey,
    ).toBeNull();
  });
});

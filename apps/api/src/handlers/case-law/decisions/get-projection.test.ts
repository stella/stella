import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sql";

import { decisionRecordQuery } from "@/api/handlers/case-law/decisions/get";
import { createSafeId } from "@/api/lib/branded-types";

const queryDb = drizzle.mock();

test("decision metadata selects payload presence without transferring AST or sections", () => {
  const statement = decisionRecordQuery(
    queryDb,
    createSafeId<"caseLawDecision">(),
  );
  const query = statement.toSQL();
  expect("documentAst" in statement.getSelectedFields()).toBe(false);
  expect("sections" in statement.getSelectedFields()).toBe(false);
  expect(query.sql).toContain('"document_ast" IS NOT NULL');
});

import { expect, test } from "bun:test";
import { getColumns } from "drizzle-orm";

import { createMockDatabase } from "@/api/db/sql-client";
import { decisionRecordQuery } from "@/api/handlers/case-law/decisions/get";
import { createSafeId } from "@/api/lib/branded-types";

const queryDb = createMockDatabase();

test("decision metadata selects payload presence without transferring AST or sections", () => {
  const statement = decisionRecordQuery(
    queryDb,
    createSafeId<"caseLawDecision">(),
  );
  const query = statement.toSQL();
  const fields = getColumns(statement.as("decision_metadata"));
  expect("id" in fields).toBe(true);
  expect("documentAst" in fields).toBe(false);
  expect("sections" in fields).toBe(false);
  expect(query.sql).toContain('"document_ast" IS NOT NULL');
});

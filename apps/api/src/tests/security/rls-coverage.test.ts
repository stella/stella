import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { SETTING_ORGANIZATION_ID, SETTING_WORKSPACE_IDS } from "@/api/db/rls";
import {
  createTestIds,
  fetchScopedTables,
  fetchStellaPolicies,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { createTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  testDb = await createTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
});

afterAll(async () => {
  await testDb.$client.close();
});

// ════════════════════════════════════════════════════════
// Policy existence: every scoped table has policies
// ════════════════════════════════════════════════════════

describe("policy coverage", () => {
  // Tables exempt from RLS
  const EXEMPT: string[] = [
    "search_documents", // TODO in schema
    "extracted_content", // TODO in schema
    "invitation", // auth table, no RLS
    "member", // auth table, no RLS
  ];

  test("every table with workspace_id has workspace policies", async () => {
    const scoped = await fetchScopedTables(testDb);
    const policies = await fetchStellaPolicies(testDb);

    const wsTables = scoped
      .filter((t) => t.scope === "workspace")
      .map((t) => t.table_name)
      .filter((t) => !EXEMPT.includes(t));

    for (const table of wsTables) {
      const tablePolicies = policies.filter((p) => p.table_name === table);
      const cmds = new Set(tablePolicies.map((p) => p.command));
      expect(cmds).toContain("r"); // SELECT
      expect(cmds).toContain("a"); // INSERT
      expect(cmds).toContain("w"); // UPDATE
      expect(cmds).toContain("d"); // DELETE

      // Verify expressions reference the correct column
      // AND the correct session variable
      for (const pol of tablePolicies) {
        const expr = pol.command === "a" ? pol.check_expr : pol.using_expr;
        expect(expr).toContain("workspace_id");
        expect(expr).toContain(SETTING_WORKSPACE_IDS);
      }
    }
  });

  test("every table with organization_id (org-only) has org policies", async () => {
    const scoped = await fetchScopedTables(testDb);
    const policies = await fetchStellaPolicies(testDb);

    const wsTableNames = new Set(
      scoped.filter((t) => t.scope === "workspace").map((t) => t.table_name),
    );

    const orgOnlyTables = scoped
      .filter((t) => t.scope === "organization")
      .map((t) => t.table_name)
      .filter((t) => !wsTableNames.has(t))
      .filter((t) => !EXEMPT.includes(t))
      // workspaces has custom policies, not org policies
      .filter((t) => t !== "workspaces");

    for (const table of orgOnlyTables) {
      const tablePolicies = policies.filter((p) => p.table_name === table);
      const cmds = new Set(tablePolicies.map((p) => p.command));
      expect(cmds).toContain("r");
      expect(cmds).toContain("a");
      expect(cmds).toContain("w");
      expect(cmds).toContain("d");

      // Verify expressions reference the correct column
      // AND the correct session variable
      for (const pol of tablePolicies) {
        const expr = pol.command === "a" ? pol.check_expr : pol.using_expr;
        expect(expr).toContain("organization_id");
        expect(expr).toContain(SETTING_ORGANIZATION_ID);
      }
    }
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  SETTING_ORGANIZATION_ID,
  SETTING_USER_ID,
  SETTING_WORKSPACE_IDS,
} from "@/api/db/rls";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import {
  fetchScopedTables,
  fetchStellaPolicies,
} from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
});

afterAll(async () => {
  await releaseRlsFixture();
});

// ════════════════════════════════════════════════════════
// Policy existence: every scoped table has policies
// ════════════════════════════════════════════════════════

describe("policy coverage", () => {
  // Tables exempt from RLS
  const EXEMPT = new Set([
    "search_documents", // TODO in schema
    "extracted_content", // TODO in schema
    "invitation", // auth table, no RLS
    "member", // auth table, no RLS
  ]);
  const APPEND_ONLY = new Set(["audit_logs"]);

  test("every table with workspace_id has workspace policies", async () => {
    const scoped = await fetchScopedTables(testDb);
    const policies = await fetchStellaPolicies(testDb);

    const wsTables = scoped
      .filter((t) => t.scope === "workspace")
      .map((t) => t.table_name)
      .filter((t) => !EXEMPT.has(t));

    for (const table of wsTables) {
      const tablePolicies = policies.filter((p) => p.table_name === table);
      const cmds = new Set(tablePolicies.map((p) => p.command));
      expect(cmds).toContain("r"); // SELECT
      expect(cmds).toContain("a"); // INSERT
      if (APPEND_ONLY.has(table)) {
        continue;
      }
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
      .filter((t) => !EXEMPT.has(t))
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

  test("chat tables have user + optional workspace policies", async () => {
    const policies = await fetchStellaPolicies(testDb);

    for (const table of ["chat_threads", "chat_messages"]) {
      const tablePolicies = policies.filter((p) => p.table_name === table);
      const cmds = new Set(tablePolicies.map((p) => p.command));
      expect(cmds).toContain("r");
      expect(cmds).toContain("a");
      expect(cmds).toContain("w");
      expect(cmds).toContain("d");

      for (const pol of tablePolicies) {
        const expr = pol.command === "a" ? pol.check_expr : pol.using_expr;
        expect(expr).toContain("user_id");
        expect(expr).toContain(SETTING_USER_ID);
        expect(expr).toContain("workspace_id IS NULL");
        expect(expr).toContain(SETTING_WORKSPACE_IDS);
      }
    }
  });

  test("user_files has user policies", async () => {
    const policies = await fetchStellaPolicies(testDb);
    const tablePolicies = policies.filter((p) => p.table_name === "user_files");
    const cmds = new Set(tablePolicies.map((p) => p.command));
    expect(cmds).toContain("r");
    expect(cmds).toContain("a");
    expect(cmds).toContain("w");
    expect(cmds).toContain("d");

    for (const pol of tablePolicies) {
      const expr = pol.command === "a" ? pol.check_expr : pol.using_expr;
      expect(expr).toContain("user_id");
      expect(expr).toContain(SETTING_USER_ID);
    }
  });
});

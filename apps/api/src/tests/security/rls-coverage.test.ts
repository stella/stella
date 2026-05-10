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
  fetchStellaTablePrivileges,
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
  const GLOBAL_CASE_LAW_TABLES = [
    "case_law_citations",
    "case_law_court_weights",
    "case_law_decisions",
    "case_law_fts_configs",
    "case_law_ingestion_events",
    "case_law_ingestion_failures",
    "case_law_polarity_rules",
    "case_law_search_documents",
    "case_law_sources",
  ];

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

  test("auth and global case-law tables have explicit stella policy boundaries", async () => {
    const policies = await fetchStellaPolicies(testDb);
    const commandsFor = (table: string) =>
      policies
        .filter((p) => p.table_name === table)
        .map((p) => p.command)
        .sort();

    expect(commandsFor("user")).toEqual(["r"]);
    expect(commandsFor("organization")).toEqual(["r"]);
    expect(commandsFor("member")).toEqual(["r", "w"]);

    const memberUpdate = policies.find(
      (p) =>
        p.table_name === "member" &&
        p.policy_name === "auth_member_update_last_active_workspace",
    );
    expect(memberUpdate?.using_expr).toContain(SETTING_ORGANIZATION_ID);
    expect(memberUpdate?.check_expr).toContain(SETTING_ORGANIZATION_ID);

    for (const table of [
      "account",
      "invitation",
      "jwks",
      "oauth_access_token",
      "oauth_client",
      "oauth_consent",
      "oauth_refresh_token",
      "session",
      "verification",
    ]) {
      const denyPolicy = policies.find(
        (p) =>
          p.table_name === table && p.policy_name === "auth_no_stella_access",
      );
      expect(denyPolicy?.command).toBe("*");
      expect(denyPolicy?.using_expr).toBe("false");
      expect(denyPolicy?.check_expr).toBe("false");
    }

    const tablePrivileges = await fetchStellaTablePrivileges(testDb);
    const privilegesFor = (table: string) =>
      tablePrivileges
        .filter((p) => p.table_name === table)
        .map((p) => p.privilege)
        .sort();

    for (const table of GLOBAL_CASE_LAW_TABLES) {
      const globalPolicy = policies.find(
        (p) =>
          p.table_name === table && p.policy_name === "case_law_global_access",
      );
      expect(globalPolicy?.command).toBe("r");
      expect(globalPolicy?.using_expr).toBe("true");
      expect(globalPolicy?.check_expr).toBeNull();
      expect(privilegesFor(table)).toEqual(["SELECT"]);
    }
  });
});

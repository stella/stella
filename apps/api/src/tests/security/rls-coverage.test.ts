import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { AUTH_USER_STELLA_SELECT_COLUMN_NAMES } from "@/api/db/auth-schema";
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
  fetchStellaIngestionColumnPrivileges,
  fetchStellaIngestionPolicies,
  fetchStellaIngestionTablePrivileges,
  fetchStellaUserSelectColumnPrivileges,
  fetchStellaTablePrivileges,
  fetchStellaPolicies,
} from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;

type TablePrivilege = {
  table_name: string;
  privilege: string;
};

const privilegesForTable = (
  tablePrivileges: readonly TablePrivilege[],
  table: string,
) =>
  tablePrivileges
    .filter((p) => p.table_name === table)
    .map((p) => p.privilege)
    .sort();

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
    // The anonymization catalog tables carry a nullable workspace_id
    // so the same row set holds both org-wide defaults and
    // workspace-only entries; their RLS is org-scoped on purpose.
    // Tightening to workspace policies requires a coordinated rewrite
    // of the org-settings handlers that still read these rows by
    // organization_id alone, so the policy coverage test exempts the
    // pair until that lands.
    "anonymization_allowlist_entries",
    "anonymization_blacklist_entries",
    // Usage governance rows are scoped at the organization level even
    // when an event optionally records a workspace_id for attribution.
    // The table-specific test below asserts the stricter app-role
    // write boundaries for these system-owned ledger tables.
    "usage_entitlements",
    "usage_allocations",
    "usage_events",
  ]);
  const APPEND_ONLY = new Set(["audit_logs"]);
  const GLOBAL_CASE_LAW_TABLES = [
    "case_law_citations",
    "case_law_court_weights",
    "case_law_decisions",
    "case_law_fts_configs",
    "case_law_index_jobs",
    "case_law_ingestion_events",
    "case_law_ingestion_failures",
    "case_law_polarity_rules",
    "case_law_search_documents",
    "case_law_sources",
    "legislation_sources",
    "legislation_documents",
    "legislation_search_documents",
    "legislation_index_jobs",
  ];
  // *_sources are config (column-restricted writes); *_index_jobs are
  // append-only audit trails (SELECT + INSERT).
  const CONFIG_OR_APPEND_ONLY = new Set([
    "case_law_sources",
    "case_law_index_jobs",
    "legislation_sources",
    "legislation_index_jobs",
  ]);
  const INGESTION_MUTABLE_CASE_LAW_TABLES = GLOBAL_CASE_LAW_TABLES.filter(
    (table) => !CONFIG_OR_APPEND_ONLY.has(table),
  );

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

  test("audit_logs is append-only: UPDATE and DELETE are denied for stella", async () => {
    const policies = await fetchStellaPolicies(testDb);
    const auditPolicies = policies.filter((p) => p.table_name === "audit_logs");

    // SELECT + INSERT are the only operations the audit trail exposes.
    expect(auditPolicies.filter((p) => p.command === "r")).toHaveLength(1);
    expect(auditPolicies.filter((p) => p.command === "a")).toHaveLength(1);

    // UPDATE / DELETE are locked by RESTRICTIVE `false` policies. A
    // RESTRICTIVE policy is AND-ed with every permissive one, so a
    // later migration that adds a permissive UPDATE/DELETE policy
    // cannot silently unlock mutation of the audit trail.
    for (const command of ["w", "d"] as const) {
      const denyPolicies = auditPolicies.filter((p) => p.command === command);
      expect(denyPolicies).toHaveLength(1);
      const denyPolicy = denyPolicies.at(0);
      expect(denyPolicy?.permissive).toBe(false);
      expect(denyPolicy?.using_expr).toBe("false");
    }
  });

  test("usage governance tables expose only intended app-role access", async () => {
    const policies = await fetchStellaPolicies(testDb);
    const tablePrivileges = await fetchStellaTablePrivileges(testDb);

    for (const table of [
      "usage_policies",
      "usage_entitlements",
      "usage_allocations",
      "usage_events",
      "usage_provider_webhook_events",
    ]) {
      expect(privilegesForTable(tablePrivileges, table)).toEqual([
        "DELETE",
        "INSERT",
        "SELECT",
        "UPDATE",
      ]);
    }

    const policyConfig = policies.find(
      (p) =>
        p.table_name === "usage_policies" &&
        p.policy_name === "usage_policies_select",
    );
    expect(policyConfig?.command).toBe("r");
    expect(policyConfig?.using_expr).toBe("true");
    expect(policyConfig?.check_expr).toBeNull();

    for (const table of ["usage_entitlements", "usage_allocations"]) {
      const selectPolicy = policies.find(
        (p) => p.table_name === table && p.policy_name === `${table}_select`,
      );
      expect(selectPolicy?.command).toBe("r");
      expect(selectPolicy?.using_expr).toContain("organization_id");
      expect(selectPolicy?.using_expr).toContain(SETTING_ORGANIZATION_ID);

      for (const [suffix, command, exprKey] of [
        ["no_insert", "a", "check_expr"],
        ["no_update", "w", "using_expr"],
        ["no_delete", "d", "using_expr"],
      ] as const) {
        const denyPolicy = policies.find(
          (p) =>
            p.table_name === table && p.policy_name === `${table}_${suffix}`,
        );
        expect(denyPolicy?.command).toBe(command);
        expect(denyPolicy?.permissive).toBe(false);
        expect(denyPolicy?.[exprKey]).toBe("false");
      }
    }

    const usageEventSelect = policies.find(
      (p) =>
        p.table_name === "usage_events" &&
        p.policy_name === "usage_events_select",
    );
    expect(usageEventSelect?.command).toBe("r");
    expect(usageEventSelect?.using_expr).toContain("organization_id");
    expect(usageEventSelect?.using_expr).toContain(SETTING_ORGANIZATION_ID);

    const usageEventInsert = policies.find(
      (p) =>
        p.table_name === "usage_events" &&
        p.policy_name === "usage_events_insert",
    );
    expect(usageEventInsert?.command).toBe("a");
    expect(usageEventInsert?.check_expr).toContain("organization_id");
    expect(usageEventInsert?.check_expr).toContain(SETTING_ORGANIZATION_ID);

    for (const [policyName, command] of [
      ["usage_events_no_update", "w"],
      ["usage_events_no_delete", "d"],
    ] as const) {
      const denyPolicy = policies.find(
        (p) => p.table_name === "usage_events" && p.policy_name === policyName,
      );
      expect(denyPolicy?.command).toBe(command);
      expect(denyPolicy?.permissive).toBe(false);
      expect(denyPolicy?.using_expr).toBe("false");
    }

    const webhookPolicy = policies.find(
      (p) =>
        p.table_name === "usage_provider_webhook_events" &&
        p.policy_name === "usage_provider_webhook_events_no_stella_access",
    );
    expect(webhookPolicy?.command).toBe("*");
    expect(webhookPolicy?.using_expr).toBe("false");
    expect(webhookPolicy?.check_expr).toBe("false");
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
    const userColumnPrivileges =
      await fetchStellaUserSelectColumnPrivileges(testDb);

    expect(privilegesForTable(tablePrivileges, "user")).toEqual([]);
    expect(
      userColumnPrivileges
        .filter((p) => p.table_name === "user" && p.privilege === "SELECT")
        .map((p) => p.column_name)
        .sort(),
    ).toEqual(AUTH_USER_STELLA_SELECT_COLUMN_NAMES.toSorted());

    for (const table of GLOBAL_CASE_LAW_TABLES) {
      const globalPolicy = policies.find(
        (p) =>
          p.table_name === table && p.policy_name === "case_law_global_access",
      );
      expect(globalPolicy?.command).toBe("r");
      expect(globalPolicy?.using_expr).toBe("true");
      expect(globalPolicy?.check_expr).toBeNull();
      expect(privilegesForTable(tablePrivileges, table)).toEqual(["SELECT"]);
    }
  });

  test("case-law ingestion role has explicit narrow write boundaries", async () => {
    const policies = await fetchStellaIngestionPolicies(testDb);
    const tablePrivileges = await fetchStellaIngestionTablePrivileges(testDb);
    const columnPrivileges = await fetchStellaIngestionColumnPrivileges(testDb);

    for (const table of GLOBAL_CASE_LAW_TABLES) {
      const ingestionPolicy = policies.find(
        (p) =>
          p.table_name === table &&
          p.policy_name === "case_law_ingestion_access",
      );
      expect(ingestionPolicy?.command).toBe("*");
      expect(ingestionPolicy?.using_expr).toBe("true");
      expect(ingestionPolicy?.check_expr).toBe("true");
    }

    for (const table of INGESTION_MUTABLE_CASE_LAW_TABLES) {
      expect(privilegesForTable(tablePrivileges, table)).toEqual([
        "DELETE",
        "INSERT",
        "SELECT",
        "UPDATE",
      ]);
    }

    expect(privilegesForTable(tablePrivileges, "case_law_sources")).toEqual([
      "SELECT",
    ]);
    expect(
      columnPrivileges
        .filter((p) => p.table_name === "case_law_sources")
        .map((p) => p.column_name)
        .sort(),
    ).toEqual(["last_sync_at", "sync_cursor", "updated_at"]);

    // Append-only audit trail: ingestion may read and append, never
    // mutate or delete prior rows.
    expect(privilegesForTable(tablePrivileges, "case_law_index_jobs")).toEqual([
      "INSERT",
      "SELECT",
    ]);

    // Legislation mirrors case law: config source (column writes only) +
    // append-only audit trail.
    expect(privilegesForTable(tablePrivileges, "legislation_sources")).toEqual([
      "SELECT",
    ]);
    expect(
      columnPrivileges
        .filter((p) => p.table_name === "legislation_sources")
        .map((p) => p.column_name)
        .sort(),
    ).toEqual(["last_sync_at", "sync_cursor", "updated_at"]);
    expect(
      privilegesForTable(tablePrivileges, "legislation_index_jobs"),
    ).toEqual(["INSERT", "SELECT"]);
  });
});

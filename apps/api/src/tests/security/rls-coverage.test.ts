import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import {
  CLIENT_MATTER_ADMIN_ROLES,
  ORGANIZATION_MANAGEMENT_ROLES,
} from "@stll/permissions";

import { AUTH_USER_STELLA_SELECT_COLUMN_NAMES } from "@/api/db/auth-schema";
import {
  SETTING_ORGANIZATION_ID,
  SETTING_USER_ID,
  SETTING_WORKSPACE_IDS,
  WORKSPACE_ACCESS_VIEW_NAME,
  stella,
  stellaIngestion,
} from "@/api/db/rls";
import {
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { isMemberRole } from "@/api/lib/member-roles";
import { CASE_LAW_SOURCE_INGESTION_UPDATE_COLUMNS } from "@/api/tests/pglite-test-db";
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
  fetchWorkspaceTenantPairForeignKeys,
} from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;

/** The literal lists Postgres prints for `role IN (...)` in a definition. */
const roleListsIn = (definition: string): Set<string>[] =>
  [...definition.matchAll(/role = ANY \(+ARRAY\[([^\]]*)\]/gu)].map(
    ([, list = ""]) =>
      new Set([...list.matchAll(/'([^']*)'/gu)].map(([, role = ""]) => role)),
  );

const isSameSet = (
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean =>
  left.size === right.size && [...left].every((value) => right.has(value));

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
    .toSorted();

type RestrictivePolicy = {
  table_name: string;
  policy_name: string;
  command: string;
  using_expr: string | null;
  check_expr: string | null;
};

/** The one restrictive policy allowed to admit rows: the entity feature fence. */
const ENTITY_FEATURE_POLICY_NAME = "workspace_entity_feature";

const depthChange = (char: string | undefined): number => {
  if (char === "(") {
    return 1;
  }
  return char === ")" ? -1 : 0;
};

/** Drops parentheses that wrap the whole expression. */
const unwrap = (expr: string): string => {
  let current = expr.trim();
  while (current.startsWith("(")) {
    let depth = 0;
    let closesAtEnd = false;
    for (let index = 0; index < current.length; index += 1) {
      depth += depthChange(current[index]);
      if (depth === 0) {
        closesAtEnd = index === current.length - 1;
        break;
      }
    }
    if (!closesAtEnd) {
      return current;
    }
    current = current.slice(1, -1).trim();
  }
  return current;
};

/** Splits on a boolean operator outside any parentheses. */
const splitTopLevel = (expr: string, operator: "AND" | "OR"): string[] => {
  const parts: string[] = [];
  const separator = ` ${operator} `;
  let depth = 0;
  let start = 0;
  for (let index = 0; index < expr.length; index += 1) {
    const char = expr[index];
    depth += depthChange(char);
    if (depth === 0 && expr.startsWith(separator, index)) {
      parts.push(unwrap(expr.slice(start, index)));
      start = index + separator.length;
    }
  }
  parts.push(unwrap(expr.slice(start)));
  return parts;
};

/** A nullable reference admits the row only while its owner is visible. */
const OWNER_VISIBLE_CONJUNCT =
  /^CASE WHEN \(\w+ IS NULL\) THEN true ELSE \(EXISTS \( SELECT 1\s+FROM (?:entities e|entity_versions v|fields f|\w+ parent_row)\s+WHERE \((?:e|v|f|parent_row)\.id = \w+\.\w+\)\)\) END$/u;

/** A list item is visible when it is a task or the caller holds the lists grant. */
const isListItemGate = (conjunct: string): boolean => {
  const [isNull, isTask, granted, ...rest] = splitTopLevel(conjunct, "OR");
  return (
    rest.length === 0 &&
    isNull === "list_item_type IS NULL" &&
    isTask === "list_item_type = 'task'::text" &&
    granted !== undefined &&
    /^\(?COALESCE\(.*current_setting\('app\.enabled_features'::text, true\)/su.test(
      granted,
    ) &&
    granted.endsWith(`? '${LEGAL_LISTS_FEATURE_ID}'::text`)
  );
};

/** Every conjunct must be a recognised fence; one admitting all rows fails. */
const isEntityFeatureFence = (expr: string): boolean =>
  // Postgres pretty-prints CASE over several lines; compare one-line text.
  splitTopLevel(unwrap(expr.replaceAll(/\s+/gu, " ")), "AND").every(
    (conjunct) =>
      OWNER_VISIBLE_CONJUNCT.test(conjunct) || isListItemGate(conjunct),
  );

/** Every other restrictive policy is a deny; widening one must fail coverage. */
const restrictivePolicyViolation = (
  policy: RestrictivePolicy,
): string | undefined => {
  const name = `${policy.table_name}.${policy.policy_name}`;
  const expr = policy.command === "a" ? policy.check_expr : policy.using_expr;
  if (policy.policy_name !== ENTITY_FEATURE_POLICY_NAME) {
    return expr === "false"
      ? undefined
      : `${name} must deny: ${expr ?? "no expression"}`;
  }
  if (policy.using_expr !== policy.check_expr) {
    return `${name} must fence reads and writes alike`;
  }
  return expr !== null && isEntityFeatureFence(expr)
    ? undefined
    : `${name} must fence through the entity owner: ${expr ?? "no expression"}`;
};

beforeAll(
  async () => {
    const fixture = await getRlsFixture();
    testDb = fixture.testDb;
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  await releaseRlsFixture();
});

// ════════════════════════════════════════════════════════
// Policy existence: every scoped table has policies
// ════════════════════════════════════════════════════════

describe("policy coverage", () => {
  test("restrictive policies stay denies unless they are the entity feature fence", () => {
    const deny = {
      table_name: "entities",
      policy_name: "entities_deny_delete",
      command: "d",
      using_expr: "false",
      check_expr: null,
    };
    expect(restrictivePolicyViolation(deny)).toBeUndefined();
    expect(
      restrictivePolicyViolation({ ...deny, using_expr: "true" }),
    ).toBeDefined();

    const fence = {
      table_name: "correspondence",
      policy_name: ENTITY_FEATURE_POLICY_NAME,
      command: "*",
      using_expr:
        "CASE WHEN (source_entity_id IS NULL) THEN true ELSE (EXISTS ( SELECT 1\n   FROM entities e\n  WHERE (e.id = correspondence.source_entity_id))) END",
      check_expr: null,
    };
    const fenced = { ...fence, check_expr: fence.using_expr };
    const deparsed =
      "CASE\n    WHEN (entity_version_id IS NULL) THEN true\n    ELSE (EXISTS ( SELECT 1\n       FROM entity_versions v\n      WHERE (v.id = cell_metadata.entity_version_id)))\nEND";
    expect(
      restrictivePolicyViolation({
        ...fence,
        table_name: "cell_metadata",
        using_expr: deparsed,
        check_expr: deparsed,
      }),
    ).toBeUndefined();
    expect(restrictivePolicyViolation(fenced)).toBeUndefined();
    expect(restrictivePolicyViolation(fence)).toBeDefined();
    const parentFence =
      "CASE WHEN (run_id IS NULL) THEN true ELSE (EXISTS ( SELECT 1\n   FROM document_translation_runs parent_row\n  WHERE (parent_row.id = document_translation_units.run_id))) END";
    expect(
      restrictivePolicyViolation({
        ...fence,
        table_name: "document_translation_units",
        using_expr: parentFence,
        check_expr: parentFence,
      }),
    ).toBeUndefined();
    expect(
      restrictivePolicyViolation({
        ...fence,
        using_expr: "true",
        check_expr: "true",
      }),
    ).toBeDefined();

    const both = `((${fence.using_expr}) AND (${parentFence}))`;
    expect(
      restrictivePolicyViolation({
        ...fence,
        using_expr: both,
        check_expr: both,
      }),
    ).toBeUndefined();
    const listGate =
      "((list_item_type IS NULL) OR (list_item_type = 'task'::text) OR ((COALESCE(NULLIF(current_setting('app.enabled_features'::text, true), ''::text), '[]'::text))::jsonb ? 'legal-lists'::text))";
    expect(
      restrictivePolicyViolation({
        ...fence,
        table_name: "entities",
        using_expr: listGate,
        check_expr: listGate,
      }),
    ).toBeUndefined();
    // The gate must name the lists grant itself, not another feature's.
    const otherGrant = listGate.replace(
      `'${LEGAL_LISTS_FEATURE_ID}'`,
      () => `'${LIST_VERIFICATION_FEATURE_ID}'`,
    );
    expect(otherGrant).not.toBe(listGate);
    expect(
      restrictivePolicyViolation({
        ...fence,
        table_name: "entities",
        using_expr: otherGrant,
        check_expr: otherGrant,
      }),
    ).toBeDefined();
    // Each conjunct must fence on its own: an OR with true admits every row.
    for (const widened of [
      "(true OR (current_setting('app.enabled_features'::text, true))::jsonb ? 'legal-lists'::text)",
      `(true OR ${fence.using_expr})`,
      `((${fence.using_expr}) AND true)`,
      listGate.replace("(list_item_type IS NULL)", "true"),
    ]) {
      expect(
        restrictivePolicyViolation({
          ...fence,
          using_expr: widened,
          check_expr: widened,
        }),
      ).toBeDefined();
    }
  });

  // Tables exempt from RLS
  const EXEMPT = new Set([
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
    // Operator observations deny the request role entirely; their dedicated
    // assertion below checks policies and privileges instead of tenant CRUD.
    "action_cost_records",
    "action_cost_calls",
    // Root-owned lifecycle history is tenant-readable but app-role immutable;
    // its dedicated assertion below covers the restrictive write policies.
    "extraction_runs",
    // Control-plane auth table: same trust tier as oauth_client /
    // agent_registration. It carries organization_id/user_id columns but is
    // not tenant-scoped — it has a deny-all RLS policy plus REVOKE ALL from
    // stella, so the org-policy coverage requirement does not apply.
    "agent_delegation",
    // Filed feedback reports: organization_id/user_id record who filed a
    // report for the maintainers' private view and are never a tenant scope.
    // The table has no read surface at all: RLS is enabled with no policy and
    // every privilege is revoked from stella (asserted in
    // rls-table-grants.test.ts), so there is no org policy to require.
    "feedback_reports",
    // Professional-use acceptances are written once at organization creation
    // on the owner connection and deny the request role entirely
    // (asserted in rls-table-grants.test.ts).
    "organization_professional_use_acceptances",
    // A notification is addressed to a person, not to a matter: recipient and
    // organization are what admit the row, and its nullable workspace_id is a
    // link pointer the client resolves through the ordinary authorized routes,
    // never a permission. Workspace policies would additionally hide the rows
    // whose matter has since been deleted, which are exactly the rows whose
    // message the recipient still needs to read.
    "notifications",
    // A timer belongs to its user and organization before a matter is chosen.
    // Its nullable matter pointer does not admit the row; the dedicated timer
    // assertion covers owner policies and the restrictive membership check.
    "time_timers",
    // The entry timer projection has member reads and truth-bound owner/admin
    // INSERT/UPDATE, with identity immutability enforced by its trigger.
    "time_entry_timer_states",
    // Owner/admin targets have a dedicated policy assertion and no DELETE grant.
    "time_daily_targets",
    // AI memory is multi-scope (org OR user OR workspace in one table)
    // and archive-only (no permissive DELETE). The generic workspace /
    // org loops can't express either shape; the dedicated test below
    // asserts its real policy boundaries.
    "ai_memories",
    // The reference ledger is an organization-wide registry of matter
    // references that have numbered documents; its nullable workspace_id
    // names the owning matter, it is not what admits the row. The matter
    // update reads it precisely to refuse a reference owned by a DIFFERENT
    // matter, and a null owner (deleted matter) must still refuse, so
    // workspace policies would hide exactly the rows the check exists to
    // find. Organization is the real boundary and the org policies pin it.
    "document_reference_counters",
  ]);
  const APPEND_ONLY = new Set(["audit_logs"]);
  const INSERT_ONLY = new Set([
    "entity_deletion_cleanup_requests",
    "template_deletion_cleanup_requests",
  ]);
  // History tables written only by a SECURITY DEFINER trigger: the app role
  // reads them and has no write policy at all.
  const SELECT_ONLY = new Set(["agent_skill_revisions"]);
  const GLOBAL_CASE_LAW_TABLES = [
    "case_law_citations",
    "case_law_court_weights",
    "case_law_court_directory_ranks",
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
  // Sources are config (column-restricted writes) and index jobs are
  // append-only audit trails.
  const CONFIG_OR_APPEND_ONLY = new Set([
    "case_law_sources",
    "case_law_index_jobs",
    "legislation_sources",
    "legislation_index_jobs",
  ]);
  const INGESTION_CASE_LAW_TABLES = [
    ...GLOBAL_CASE_LAW_TABLES,
    "case_law_search_backfill_failures",
  ];
  const INGESTION_MUTABLE_CASE_LAW_TABLES = INGESTION_CASE_LAW_TABLES.filter(
    (table) => !CONFIG_OR_APPEND_ONLY.has(table),
  );

  test("workspace access view is granted only to the application role", async () => {
    const result = await testDb.execute<{
      ingestion_view_select: boolean;
      stella_view_select: boolean;
    }>(sql`
      SELECT
        has_table_privilege(
          ${stella.name},
          ${`public.${WORKSPACE_ACCESS_VIEW_NAME}`},
          'SELECT'
        ) AS stella_view_select,
        has_table_privilege(
          ${stellaIngestion.name},
          ${`public.${WORKSPACE_ACCESS_VIEW_NAME}`},
          'SELECT'
        ) AS ingestion_view_select
    `);
    const privileges = result.rows.at(0);

    expect(privileges).toEqual({
      ingestion_view_select: false,
      stella_view_select: true,
    });
  });

  test("workspace access view keeps its owner-evaluated security boundary", async () => {
    const result = await testDb.execute<{
      base_tables_force_rls: boolean;
      owner_matches_base_tables: boolean;
      security_barrier: boolean;
      security_invoker: boolean;
      view_owned_by_stella: boolean;
    }>(sql`
      SELECT
        COALESCE('security_barrier=true' = ANY(view_rel.reloptions), false)
          AS security_barrier,
        COALESCE('security_invoker=true' = ANY(view_rel.reloptions), false)
          AS security_invoker,
        view_rel.relowner = workspaces_rel.relowner
          AND view_rel.relowner = workspace_members_rel.relowner
          AND view_rel.relowner = member_rel.relowner
          AS owner_matches_base_tables,
        view_rel.relowner = (
          SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ${stella.name}
        ) AS view_owned_by_stella,
        workspaces_rel.relforcerowsecurity
          OR workspace_members_rel.relforcerowsecurity
          OR member_rel.relforcerowsecurity
          AS base_tables_force_rls
      FROM pg_catalog.pg_class view_rel
      JOIN pg_catalog.pg_class workspaces_rel
        ON workspaces_rel.oid = 'public.workspaces'::regclass
      JOIN pg_catalog.pg_class workspace_members_rel
        ON workspace_members_rel.oid = 'public.workspace_members'::regclass
      JOIN pg_catalog.pg_class member_rel
        ON member_rel.oid = 'public.member'::regclass
      WHERE view_rel.oid = ${`public.${WORKSPACE_ACCESS_VIEW_NAME}`}::regclass
    `);

    expect(result.rows.at(0)).toEqual({
      base_tables_force_rls: false,
      owner_matches_base_tables: true,
      security_barrier: true,
      security_invoker: false,
      view_owned_by_stella: false,
    });
  });

  test("workspace access view grants client matters to CLIENT_MATTER_ADMIN_ROLES", async () => {
    const result = await testDb.execute<{ definition: string }>(sql`
      SELECT pg_catalog.pg_get_viewdef(
        ${`public.${WORKSPACE_ACCESS_VIEW_NAME}`}::regclass
      ) AS definition
    `);
    const definition = result.rows.at(0)?.definition ?? "";

    expect(roleListsIn(definition)).toEqual([
      new Set(CLIENT_MATTER_ADMIN_ROLES),
    ]);
  });

  test("every policy role list is a named role set", async () => {
    const namedSets = [
      new Set(ORGANIZATION_MANAGEMENT_ROLES),
      new Set(CLIENT_MATTER_ADMIN_ROLES),
    ];
    const policies = await fetchStellaPolicies(testDb);
    const roleLists = policies.flatMap((policy) =>
      [policy.using_expr, policy.check_expr]
        .filter((expression) => expression !== null)
        .flatMap((expression) => roleListsIn(expression))
        // Other role columns (a chat message's author) are not member roles.
        .filter((roles) => [...roles].some((role) => isMemberRole(role)))
        .map((roles) => ({
          policy: `${policy.table_name}.${policy.policy_name}`,
          roles,
        })),
    );

    // The extraction must see the management policies, or a parser that
    // matches nothing would pass vacuously.
    expect(roleLists.length).toBeGreaterThan(0);
    for (const { policy, roles } of roleLists) {
      expect({
        policy,
        named: namedSets.some((named) => isSameSet(named, roles)),
      }).toEqual({ policy, named: true });
    }
  });

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
      expect(cmds).toContain("a"); // INSERT
      if (INSERT_ONLY.has(table)) {
        expect(cmds).toEqual(new Set(["a"]));
      } else {
        expect(cmds).toContain("r"); // SELECT
        if (!APPEND_ONLY.has(table)) {
          expect(cmds).toContain("w"); // UPDATE
          expect(cmds).toContain("d"); // DELETE
        }
      }
      if (APPEND_ONLY.has(table)) {
        continue;
      }

      // Verify expressions reference the correct column
      // AND the correct session variable
      for (const pol of tablePolicies) {
        const expr = pol.command === "a" ? pol.check_expr : pol.using_expr;
        if (!pol.permissive) {
          expect(restrictivePolicyViolation(pol)).toBeUndefined();
          continue;
        }
        expect(expr).toContain("workspace_id");
        expect(expr).toContain(SETTING_WORKSPACE_IDS);
        expect(expr).toContain(WORKSPACE_ACCESS_VIEW_NAME);
        expect(expr).not.toContain("stella_workspace_is_authorized");
      }
    }
  });

  // A table that persists an organization discriminator alongside its
  // workspace must pin both in every permissive policy, whichever helper it
  // uses. Pinning the workspace alone would let a row whose organization_id
  // came from another tenant be reached through a legitimate workspace
  // authorization. The schema side of this invariant is guarded by the
  // workspace-only-rls-on-org-tables ratchet metric; this asserts the live
  // catalog agrees, which is what actually enforces it. Deliberately without
  // an exemption set: a dual-column table that cannot pin both is a design
  // question, not a waiver.
  test("every table with workspace_id and organization_id pins both scopes", async () => {
    const scoped = await fetchScopedTables(testDb);
    const policies = await fetchStellaPolicies(testDb);

    const byScope = new Map<string, Set<string>>();
    for (const { table_name, scope } of scoped) {
      const scopes = byScope.get(table_name) ?? new Set<string>();
      scopes.add(scope);
      byScope.set(table_name, scopes);
    }

    const dualScopeTables = [...byScope.entries()]
      .filter(
        ([, scopes]) => scopes.has("workspace") && scopes.has("organization"),
      )
      .map(([table]) => table);

    // The class exists: an empty list would make every assertion below vacuous.
    expect(dualScopeTables.length).toBeGreaterThan(0);

    const unpinned: string[] = [];
    for (const table of dualScopeTables) {
      for (const pol of policies.filter((p) => p.table_name === table)) {
        if (!pol.permissive) {
          continue;
        }
        const expr = pol.command === "a" ? pol.check_expr : pol.using_expr;
        if (
          expr === null ||
          !expr.includes("organization_id") ||
          !expr.includes(SETTING_ORGANIZATION_ID)
        ) {
          unpinned.push(`${table}.${pol.policy_name}`);
        }
      }
    }

    expect(unpinned).toEqual([]);
  });

  // The policy test above states the tenant pair as an authorization rule.
  // This one states it as a storage rule: a row whose organization_id does not
  // belong to its workspace_id cannot be written at all, whatever policy or
  // handler produced it. Only three tables carried the reference before, so
  // "the pattern exists somewhere" was not the same as "the class is closed".
  //
  // Exemptions are properties of the table, not waivers, and the assertions
  // below run in both directions so one cannot outlive its reason.
  const TENANT_PAIR_EXEMPT = new Map<string, string>([
    [
      "audit_logs",
      "matter deletion records the DELETE event after removing the workspace row, so any reference to workspaces would abort it",
    ],
    [
      "buffer_object_cleanup_intents",
      "storage-erasure outbox: references no ancestor so cleanup survives owner deletion (apps/api/src/db/schema/entities.test.ts)",
    ],
    [
      "entity_deletion_cleanup_requests",
      "storage-erasure outbox: references no ancestor so cleanup survives owner deletion (apps/api/src/db/schema/entities.test.ts)",
    ],
    [
      "notifications",
      "awareness pointer whose nullable workspace_id is a deep link surviving matter deletion; the pair needs ON DELETE SET NULL (workspace_id), which drizzle cannot declare",
    ],
    [
      "usage_events",
      "metering ledger whose workspace_id is nullable attribution surviving matter deletion; the pair needs ON DELETE SET NULL (workspace_id), which drizzle cannot declare",
    ],
    [
      "document_reference_counters",
      "reference registry whose workspace_id is the nullable owning matter, retained as NULL after matter deletion so the reference stays retired; the pair needs ON DELETE SET NULL (workspace_id), which drizzle cannot declare",
    ],
  ]);

  test("every table with workspace_id and organization_id references the pair", async () => {
    const scoped = await fetchScopedTables(testDb);
    const pairForeignKeys = await fetchWorkspaceTenantPairForeignKeys(testDb);

    const byScope = new Map<string, Set<string>>();
    for (const { table_name, scope } of scoped) {
      const scopes = byScope.get(table_name) ?? new Set<string>();
      scopes.add(scope);
      byScope.set(table_name, scopes);
    }

    const dualScopeTables = [...byScope.entries()]
      .filter(
        ([, scopes]) => scopes.has("workspace") && scopes.has("organization"),
      )
      .map(([table]) => table);

    // The class exists: an empty list would make every assertion below vacuous.
    expect(dualScopeTables.length).toBeGreaterThan(0);

    const referencing = new Map(
      pairForeignKeys.map((foreignKey) => [foreignKey.table_name, foreignKey]),
    );

    expect(
      dualScopeTables
        .filter((table) => !TENANT_PAIR_EXEMPT.has(table))
        .filter((table) => !referencing.has(table))
        .toSorted(),
    ).toEqual([]);

    // A constraint left NOT VALID enforces new writes only, so a forgotten
    // VALIDATE migration would leave the existing rows unchecked forever.
    expect(
      pairForeignKeys
        .filter(({ validated }) => !validated)
        .map(({ constraint_name }) => constraint_name)
        .toSorted(),
    ).toEqual([]);

    // Stale exemptions fail too: a table that lost one of the two columns, or
    // that has since taken the reference, no longer needs an entry.
    expect(
      [...TENANT_PAIR_EXEMPT.keys()]
        .filter(
          (table) => !dualScopeTables.includes(table) || referencing.has(table),
        )
        .toSorted(),
    ).toEqual([]);
  });

  test("operator observations deny every request-role operation", async () => {
    const policies = await fetchStellaPolicies(testDb);
    const privileges = await fetchStellaTablePrivileges(testDb);
    for (const table of ["action_cost_records", "action_cost_calls"]) {
      const tablePolicies = policies.filter(
        (policy) => policy.table_name === table,
      );
      expect(tablePolicies).toHaveLength(1);
      const policy = tablePolicies.at(0);
      expect(policy?.command).toBe("*");
      expect(policy?.using_expr).toBe("false");
      expect(policy?.check_expr).toBe("false");
      expect(privilegesForTable(privileges, table)).toEqual([]);
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
      if (SELECT_ONLY.has(table)) {
        expect(cmds).toEqual(new Set(["r"]));
      } else if (INSERT_ONLY.has(table)) {
        expect(cmds).toEqual(new Set(["a"]));
      } else {
        expect(cmds).toContain("a");
        expect(cmds).toContain("r");
        expect(cmds).toContain("w");
        expect(cmds).toContain("d");
      }

      // Verify expressions reference the correct column
      // AND the correct session variable
      for (const pol of tablePolicies) {
        const expr = pol.command === "a" ? pol.check_expr : pol.using_expr;
        if (!pol.permissive) {
          expect(expr).toBe("false");
          continue;
        }
        expect(expr).toContain("organization_id");
        expect(expr).toContain(SETTING_ORGANIZATION_ID);
      }
    }
  });

  test("daily targets require the active organization and owner or organization management", async () => {
    const policies = (await fetchStellaPolicies(testDb)).filter(
      (policy) => policy.table_name === "time_daily_targets",
    );
    expect(policies).toHaveLength(1);
    const policy = policies.at(0);
    expect(policy?.command).toBe("*");
    for (const expression of [policy?.using_expr, policy?.check_expr]) {
      expect(expression).toContain(SETTING_ORGANIZATION_ID);
      expect(expression).toContain(SETTING_USER_ID);
      expect(expression).toContain("owner");
      expect(expression).toContain("admin");
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
        expect(expr).toContain(WORKSPACE_ACCESS_VIEW_NAME);
        expect(expr).not.toContain("stella_workspace_is_authorized");
      }
    }
  });

  // The org-only loop above proves the organization predicate; this proves the
  // recipient predicate the loop cannot see. A notification is addressed to one
  // person about one firm's activity, so losing either half is a leak: dropping
  // the user predicate exposes a colleague's mentions, dropping the
  // organization predicate leaks one firm's activity into another firm's
  // session for somebody who belongs to both.
  test("notifications pin both the recipient and the organization", async () => {
    const policies = await fetchStellaPolicies(testDb);
    const tablePolicies = policies.filter(
      (p) => p.table_name === "notifications",
    );
    expect(new Set(tablePolicies.map((p) => p.command))).toEqual(
      new Set(["r", "a", "w", "d"]),
    );

    for (const policy of tablePolicies) {
      expect(policy.permissive).toBe(true);
      const expr =
        policy.command === "a" ? policy.check_expr : policy.using_expr;
      expect(expr).toContain("user_id");
      expect(expr).toContain(SETTING_USER_ID);
      expect(expr).toContain("organization_id");
      expect(expr).toContain(SETTING_ORGANIZATION_ID);
    }

    // UPDATE re-checks on write, so read-state bookkeeping cannot move a row
    // to another recipient or firm.
    const updatePolicy = tablePolicies.find((p) => p.command === "w");
    expect(updatePolicy?.check_expr).toContain(SETTING_USER_ID);
    expect(updatePolicy?.check_expr).toContain(SETTING_ORGANIZATION_ID);
  });

  test("user_files policies derive full scope from the owning thread", async () => {
    const policies = await fetchStellaPolicies(testDb);
    const tablePolicies = policies.filter((p) => p.table_name === "user_files");
    const cmds = new Set(tablePolicies.map((p) => p.command));
    expect(cmds).toContain("r");
    expect(cmds).toContain("a");
    expect(cmds).toContain("w");
    expect(cmds).toContain("d");

    for (const policy of tablePolicies) {
      const expressions = [
        policy.command === "a" ? policy.check_expr : policy.using_expr,
      ];
      if (policy.command === "w") {
        expressions.push(policy.check_expr);
      }

      for (const expression of expressions) {
        expect(expression).toContain("user_id");
        expect(expression).toContain("user_files.thread_id");
        expect(expression).toContain("chat_threads");
        expect(expression).toContain(SETTING_USER_ID);
        expect(expression).toContain(SETTING_ORGANIZATION_ID);
        expect(expression).toContain(SETTING_WORKSPACE_IDS);
        expect(expression).toContain(WORKSPACE_ACCESS_VIEW_NAME);
        expect(expression).toContain("data_workspace_ids");
      }
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

  test("extraction run history is read-only for stella", async () => {
    const policies = await fetchStellaPolicies(testDb);
    const runPolicies = policies.filter(
      (policy) => policy.table_name === "extraction_runs",
    );
    const selectPolicy = runPolicies.find(
      (policy) => policy.policy_name === "extraction_runs_workspace_select",
    );

    expect(selectPolicy?.command).toBe("r");
    expect(selectPolicy?.using_expr).toContain("workspace_id");
    expect(selectPolicy?.using_expr).toContain(SETTING_WORKSPACE_IDS);
    expect(selectPolicy?.using_expr).toContain("organization_id");
    expect(selectPolicy?.using_expr).toContain(SETTING_ORGANIZATION_ID);

    for (const [policyName, command, expression] of [
      ["extraction_runs_no_insert", "a", "check_expr"],
      ["extraction_runs_no_update", "w", "using_expr"],
      ["extraction_runs_no_delete", "d", "using_expr"],
    ] as const) {
      const denyPolicy = runPolicies.find(
        (policy) => policy.policy_name === policyName,
      );
      expect(denyPolicy?.command).toBe(command);
      expect(denyPolicy?.permissive).toBe(false);
      expect(denyPolicy?.[expression]).toBe("false");
    }
  });

  test("ai_memories is multi-scope and archive-only (no permissive delete)", async () => {
    const policies = await fetchStellaPolicies(testDb);
    const tablePolicies = policies.filter(
      (p) => p.table_name === "ai_memories",
    );
    const cmds = new Set(tablePolicies.map((p) => p.command));

    // SELECT / INSERT / UPDATE are permissive and scope-aware: a row is
    // visible only to its firm (organization), its owning user, or a
    // session-accessible matter, and matter-derived rows are gated by the
    // source_data_workspace_ids subset check (the ethical wall).
    expect(cmds).toContain("r");
    expect(cmds).toContain("a");
    expect(cmds).toContain("w");
    for (const command of ["r", "a", "w"] as const) {
      const policy = tablePolicies.find((p) => p.command === command);
      expect(policy?.permissive).toBe(true);
      const expr = command === "a" ? policy?.check_expr : policy?.using_expr;
      expect(expr).toContain("organization_id");
      expect(expr).toContain(SETTING_ORGANIZATION_ID);
      expect(expr).toContain("user_id");
      expect(expr).toContain(SETTING_USER_ID);
      expect(expr).toContain("workspace_id");
      expect(expr).toContain(SETTING_WORKSPACE_IDS);
      expect(expr).toContain("source_data_workspace_ids");
    }

    // Archive-only: DELETE is locked by a single RESTRICTIVE `false`
    // policy so a later permissive DELETE cannot silently unlock hard
    // deletes (same durability guarantee as audit_logs).
    const deletePolicies = tablePolicies.filter((p) => p.command === "d");
    expect(deletePolicies).toHaveLength(1);
    const deletePolicy = deletePolicies.at(0);
    expect(deletePolicy?.permissive).toBe(false);
    expect(deletePolicy?.using_expr).toBe("false");
  });

  test("docx_suggestions carries the contributing-matter subset check", async () => {
    const policies = await fetchStellaPolicies(testDb);
    const tablePolicies = policies.filter(
      (p) => p.table_name === "docx_suggestions",
    );

    // A suggestion is model output: it can restate content the originating
    // thread pulled from another matter, so every command applies the same
    // subset check the thread itself enforces on top of the matter scope.
    for (const command of ["r", "a", "w", "d"] as const) {
      const policy = tablePolicies.find((p) => p.command === command);
      expect(policy?.permissive).toBe(true);
      const expr = command === "a" ? policy?.check_expr : policy?.using_expr;
      expect(expr).toContain("workspace_id");
      expect(expr).toContain(SETTING_WORKSPACE_IDS);
      expect(expr).toContain("source_data_workspace_ids");
    }
  });

  test("global timers pin the owner and organization and require current membership", async () => {
    const policies = await fetchStellaPolicies(testDb);
    for (const table of ["time_timers", "time_timer_confirmations"]) {
      const tablePolicies = policies.filter(
        (policy) => policy.table_name === table,
      );
      const ownerPolicies = tablePolicies.filter(
        (policy) => policy.permissive && policy.policy_name.startsWith("user_"),
      );
      expect(
        ownerPolicies.map((policy) => policy.policy_name).toSorted(),
      ).toEqual(["user_delete", "user_insert", "user_select", "user_update"]);
      for (const [name, command] of [
        ["user_select", "r"],
        ["user_insert", "a"],
        ["user_update", "w"],
        ["user_delete", "d"],
      ] as const) {
        const policy = ownerPolicies.find(
          (candidate) => candidate.policy_name === name,
        );
        expect(policy?.command).toBe(command);
        const expressions = [];
        if (command !== "a") {
          expressions.push(policy?.using_expr);
        }
        if (command === "a" || command === "w") {
          expressions.push(policy?.check_expr);
        }
        for (const expression of expressions) {
          expect(expression).toContain("user_id");
          expect(expression).toContain(SETTING_USER_ID);
          expect(expression).toContain("organization_id");
          expect(expression).toContain(SETTING_ORGANIZATION_ID);
          expect(expression).not.toContain(SETTING_WORKSPACE_IDS);
        }
      }
      const adminCommands =
        table === "time_timers"
          ? ([
              ["organization_admin_select", "r"],
              ["organization_admin_delete", "d"],
            ] as const)
          : ([
              ["organization_admin_select", "r"],
              ["organization_admin_insert", "a"],
            ] as const);
      expect(
        tablePolicies
          .filter((policy) => policy.permissive)
          .map((policy) => policy.policy_name)
          .toSorted(),
      ).toEqual(
        [
          ...ownerPolicies.map((policy) => policy.policy_name),
          ...adminCommands.map(([name]) => name),
        ].toSorted(),
      );
      for (const [name, command] of adminCommands) {
        const policy = tablePolicies.find(
          (candidate) => candidate.policy_name === name,
        );
        expect(policy?.permissive).toBe(true);
        expect(policy?.command).toBe(command);
        const expression =
          command === "a" ? policy?.check_expr : policy?.using_expr;
        const normalized = expression?.replaceAll('"', "");
        expect(normalized).toContain("organization_id");
        expect(normalized).toContain(SETTING_ORGANIZATION_ID);
        expect(normalized).toContain("member.user_id");
        expect(normalized).toContain(SETTING_USER_ID);
        expect(normalized).toContain("member.role");
        expect(normalized).toContain("'owner'");
        expect(normalized).toContain("'admin'");
        if (table === "time_timers") {
          expect(normalized).toMatch(
            /(?:time_timers\.)?state\s*=\s*'running'/u,
          );
        }
      }
      const restrictivePolicies = tablePolicies.filter(
        (policy) => !policy.permissive,
      );
      if (table === "time_timer_confirmations") {
        expect(restrictivePolicies).toEqual([]);
        continue;
      }
      expect(restrictivePolicies).toHaveLength(1);
      const membership = restrictivePolicies.at(0);
      expect(membership?.policy_name).toBe("current_member");
      expect(membership?.command).toBe("*");
      expect(membership?.using_expr).toBe(membership?.check_expr);
      for (const expression of [
        membership?.using_expr,
        membership?.check_expr,
      ]) {
        const normalized = expression?.replaceAll('"', "");
        expect(normalized).toContain("EXISTS");
        expect(normalized).toContain("AND");
        expect(normalized).toMatch(
          /member\.organization_id\s*=\s*\(?time_timers\.organization_id/u,
        );
        expect(normalized).toMatch(
          /member\.user_id\s*=\s*time_timers\.user_id/u,
        );
      }
    }
  });

  test("entry timer state projection grants member reads and truth-bound writes only", async () => {
    const policies = await fetchStellaPolicies(testDb);
    const tablePolicies = policies.filter(
      (policy) => policy.table_name === "time_entry_timer_states",
    );
    expect(
      tablePolicies.map((policy) => policy.policy_name).toSorted(),
    ).toEqual(["member_select", "owner_admin_insert", "owner_admin_update"]);
    for (const [name, command] of [
      ["member_select", "r"],
      ["owner_admin_insert", "a"],
      ["owner_admin_update", "w"],
    ] as const) {
      const policy = tablePolicies.find(
        (candidate) => candidate.policy_name === name,
      );
      expect(policy?.command).toBe(command);
      expect(policy?.permissive).toBe(true);
      const expressions = [];
      if (command !== "a") {
        expressions.push(policy?.using_expr);
      }
      if (command !== "r") {
        expressions.push(policy?.check_expr);
      }
      for (const expression of expressions) {
        expect(expression).toContain("organization_id");
        expect(expression).toContain(SETTING_ORGANIZATION_ID);
        if (command !== "r") {
          expect(expression).toContain("member");
        }
        expect(expression).toContain(SETTING_USER_ID);
      }
      if (command === "r") {
        expect(policy?.using_expr).toContain("OR");
        expect(policy?.using_expr).toContain("time_entries");
        expect(policy?.using_expr).toContain("entry_id");
        continue;
      }
      expect(policy?.check_expr).toContain("time_timers");
      expect(policy?.check_expr).toContain("legacy_time_entry_id");
      expect(policy?.check_expr).toContain("'running'");
      expect(policy?.check_expr).toContain("'owner'");
      expect(policy?.check_expr).toContain("'admin'");
    }
    const grants = await fetchStellaTablePrivileges(testDb);
    expect(privilegesForTable(grants, "time_entry_timer_states")).toEqual([
      "INSERT",
      "SELECT",
      "UPDATE",
    ]);
  });

  test("admin timer ending requires a matching receipt and receipt creation requires a running timer", async () => {
    const policies = await fetchStellaPolicies(testDb);
    const timerDelete = policies.find(
      (policy) =>
        policy.table_name === "time_timers" &&
        policy.policy_name === "organization_admin_delete",
    );
    expect(timerDelete?.using_expr).toContain("time_timer_confirmations");
    expect(timerDelete?.using_expr).toContain("timer_id");
    expect(timerDelete?.using_expr).toContain("organization_id");
    expect(timerDelete?.using_expr).toContain("user_id");
    expect(timerDelete?.using_expr).toContain("time_entry_id IS NOT NULL");
    const receiptInsert = policies.find(
      (policy) =>
        policy.table_name === "time_timer_confirmations" &&
        policy.policy_name === "organization_admin_insert",
    );
    expect(receiptInsert?.check_expr).toContain("time_timers");
    expect(receiptInsert?.check_expr).toContain("timer_id");
    expect(receiptInsert?.check_expr).toContain("organization_id");
    expect(receiptInsert?.check_expr).toContain("user_id");
    expect(receiptInsert?.check_expr).toContain("'running'");
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
        .toSorted();

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
      "two_factor",
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
        .toSorted(),
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

    for (const table of INGESTION_CASE_LAW_TABLES) {
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
        .toSorted(),
      // Derived, not restated: this list is the one the harness grants from,
      // which `pglite-role-grants.test.ts` holds equal to the committed
      // migrations column by column. A third hand-kept copy here would drift
      // from both, which is what let `stored_total` ship with no writer.
    ).toEqual([...CASE_LAW_SOURCE_INGESTION_UPDATE_COLUMNS].toSorted());

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
        .toSorted(),
    ).toEqual(["last_sync_at", "sync_cursor", "updated_at"]);
    expect(
      privilegesForTable(tablePrivileges, "legislation_index_jobs"),
    ).toEqual(["INSERT", "SELECT"]);
  });
});

import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { isTable, sql } from "drizzle-orm";
import * as p from "drizzle-orm/pg-core";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";
import path from "node:path";

import * as agentAuthSchema from "./agent-auth-schema";
import * as authSchema from "./auth-schema";
import { installPolicy } from "./online-ddl";
import { stellaSystem } from "./rls";
import * as schema from "./schema";
import { scopedOwnerPolicyDefinitions } from "./scoped-owner-policy-definitions";
import { SCOPED_OWNER_POLICY_TABLES } from "./scoped-owner-policy-repair";
import {
  LINKED_POLICIES,
  linkedPolicyTable,
  tablePolicies,
} from "./table-policies";

const SCHEMA_TABLES: readonly PgTable[] = [
  schema,
  authSchema,
  agentAuthSchema,
].flatMap((module) =>
  Object.values(module).filter((value): value is PgTable => isTable(value)),
);

describe("table policy owner", () => {
  test("a linked policy is installed and repaired exactly like an inline one", () => {
    const fixture = p.pgTable(
      "policy_owner_fixture",
      { id: p.text("id"), organizationId: p.text("organization_id") },
      (table) => [
        p.pgPolicy("inline_owner", {
          as: "restrictive",
          to: stellaSystem,
          using: sql`${table.organizationId} = 'org'`,
          withCheck: sql`${table.id} IS NOT NULL`,
        }),
      ],
    );
    const linked = p
      .pgPolicy("linked_owner", {
        as: "restrictive",
        to: stellaSystem,
        using: sql`${fixture.organizationId} = 'org'`,
        withCheck: sql`${fixture.id} IS NOT NULL`,
      })
      .link(fixture);
    const definitions = scopedOwnerPolicyDefinitions([fixture], [linked]);
    expect(definitions.map(({ name }) => name)).toEqual([
      "inline_owner",
      "linked_owner",
    ]);
    const [inline, viaLink] = definitions;
    if (inline === undefined || viaLink === undefined) {
      panic("Both fixture policies must be defined");
    }
    const renamed = { ...viaLink, name: inline.name };
    expect(renamed).toEqual(inline);
    // The repair installs each missing definition with the same statement.
    expect(installPolicy(renamed)).toEqual(installPolicy(inline));
    expect(scopedOwnerPolicyDefinitions([fixture], [])).toEqual([inline]);
  });

  test("tables without linked policies keep a byte-identical installed policy set", () => {
    for (const table of SCHEMA_TABLES) {
      expect(tablePolicies(table, [])).toEqual(getTableConfig(table).policies);
      if (
        LINKED_POLICIES.some((policy) => linkedPolicyTable(policy) === table)
      ) {
        continue;
      }
      expect(tablePolicies(table)).toEqual(getTableConfig(table).policies);
      expect(scopedOwnerPolicyDefinitions([table])).toEqual(
        scopedOwnerPolicyDefinitions([table], []),
      );
    }
  });

  test("every linked policy is exported and reaches the installer", () => {
    const installed = new Set<unknown>(SCOPED_OWNER_POLICY_TABLES);
    for (const policy of LINKED_POLICIES) {
      expect(installed.has(linkedPolicyTable(policy)), policy.name).toBe(true);
    }
    // A linked declaration that no schema module exports is invisible to the
    // owner, so the source count must match the exported set.
    const root = path.join(import.meta.dir, "schema");
    const sources = [
      ...[...new Bun.Glob("**/*.ts").scanSync(root)]
        .filter((file) => !file.includes(".test."))
        .map((file) => path.join(root, file)),
      path.join(import.meta.dir, "auth-schema.ts"),
      path.join(import.meta.dir, "agent-auth-schema.ts"),
    ];
    const declared = sources.reduce(
      (count, file) =>
        count + (readFileSync(file, "utf-8").match(/\.link\(/gu)?.length ?? 0),
      0,
    );
    expect(declared).toBe(LINKED_POLICIES.length);
  });
});

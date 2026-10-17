import { describe, expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

import { entityFeatureGateMetadata } from "@/api/db/entity-feature-gate-metadata";
import { entityFeaturePolicyDefinitions } from "@/api/db/entity-feature-policies";
import * as schema from "@/api/db/schema";
import { blockStatementsOf } from "@/api/tests/helpers/lock-taking-sql";

import { createEntityFeatureGateRepair } from "./entity-feature-gate-repair";
import type { OnlineTableGate, PolicyDefinition } from "./online-ddl";
import type { OnlineMigrationConnection } from "./online-migration-connection";

const RELATIONS = ["alpha", "beta", "gamma"] as const;

const policyOf = (tableName: string): PolicyDefinition => ({
  tableName,
  name: "workspace_entity_feature",
  as: "restrictive",
  for: "all",
  role: "stella",
  using: `"${tableName}"."entity_feature_gate" = 'open'`,
  withCheck: `"${tableName}"."entity_feature_gate" = 'open'`,
});

/**
 * A database whose relations are all backfilled and validated, with the
 * relations in `cutOver` already on their row-local policy. A replaced policy
 * counts as cut over from then on.
 */
const fixture = (cutOver: ReadonlySet<string>) => {
  const policies = new Set(cutOver);
  const connection: OnlineMigrationConnection = {
    execute: async () => undefined,
    query: async (query, params = []) => {
      if (query.includes("jsonb_each(public.entity_feature_gate_graph())")) {
        return RELATIONS.map((name) => ({ name, keys: ["id"] }));
      }
      if (query.includes("entity_feature_gate_backfill($1, NULL, 0)")) {
        return [{ pending: false }];
      }
      if (query.includes('AS "cutOver"')) {
        const tableName = params.at(1);
        return [
          { cutOver: typeof tableName === "string" && policies.has(tableName) },
        ];
      }
      if (query.includes("pg_constraint")) {
        return [{ isValidated: true }];
      }
      throw new TypeError(`Unexpected query: ${query}`);
    },
    release: () => undefined,
  };
  return { connection, policies };
};

/** Runs gated work in place, recording each statement; `defer` holds a step. */
const recordingGate = (
  policies: Set<string>,
  defer: ReadonlySet<string> = new Set(),
) => {
  const ran: { step: string; statements: string[] }[] = [];
  const tables: OnlineTableGate = {
    run: async ({ target, work }) => {
      if (defer.has(target.name)) {
        return { type: "deferred", step: target.name, retryAfterMs: 5 };
      }
      await work({
        query: async () => [],
        run: async (statement) => {
          const statements = target.name.endsWith(".workspace_entity_feature")
            ? await blockStatementsOf(statement)
            : [];
          ran.push({ step: target.name, statements });
          if (statements.length > 0) {
            policies.add(target.tableName);
          }
        },
      });
      return { type: "complete" };
    },
  };
  return { ran, tables };
};

const repair = createEntityFeatureGateRepair({
  readPolicies: () => RELATIONS.map(policyOf),
});

const cutOverSteps = (ran: { step: string; statements: string[] }[]) =>
  ran.filter(({ statements }) => statements.length > 0);

describe("entity feature gate cutover", () => {
  test("replaces each relation's policy on its own, after every backfill", async () => {
    const { connection, policies } = fixture(new Set());
    const { ran, tables } = recordingGate(policies);
    expect(await repair.repair(connection, tables)).toEqual({
      type: "complete",
    });
    // Every relation is analyzed and validated before the first cutover.
    expect([...new Set(ran.map(({ step }) => step))]).toEqual([
      ...RELATIONS.map((name) => `${name}.entity_feature_gate`),
      ...RELATIONS.map((name) => `${name}.workspace_entity_feature`),
    ]);
    expect(cutOverSteps(ran)).toEqual(
      RELATIONS.map((name) => ({
        step: `${name}.workspace_entity_feature`,
        statements: [
          `DROP POLICY IF EXISTS "workspace_entity_feature" ON "public"."${name}"`,
          `CREATE POLICY "workspace_entity_feature" ON "public"."${name}" AS RESTRICTIVE FOR ALL TO "stella" USING ("${name}"."entity_feature_gate" = 'open') WITH CHECK ("${name}"."entity_feature_gate" = 'open')`,
        ],
      })),
    );
  });

  test("a deferred relation stops the cutover there, and the next run resumes it", async () => {
    const { connection, policies } = fixture(new Set(["alpha"]));
    const held = recordingGate(
      policies,
      new Set(["beta.workspace_entity_feature"]),
    );
    expect(await repair.repair(connection, held.tables)).toEqual({
      type: "deferred",
      step: "beta.workspace_entity_feature",
      retryAfterMs: 5,
    });
    // alpha was already cut over; gamma waits behind beta.
    expect(cutOverSteps(held.ran)).toEqual([]);
    expect([...policies]).toEqual(["alpha"]);
    const resumed = recordingGate(policies);
    expect(await repair.repair(connection, resumed.tables)).toEqual({
      type: "complete",
    });
    expect(cutOverSteps(resumed.ran).map(({ step }) => step)).toEqual([
      "beta.workspace_entity_feature",
      "gamma.workspace_entity_feature",
    ]);
  });

  test("a rerun after every relation is cut over replaces nothing", async () => {
    const { connection, policies } = fixture(new Set(RELATIONS));
    const { ran, tables } = recordingGate(policies);
    expect(await repair.repair(connection, tables)).toEqual({
      type: "complete",
    });
    expect(cutOverSteps(ran)).toEqual([]);
    expect(ran.every(({ step }) => step.endsWith(".entity_feature_gate"))).toBe(
      true,
    );
  });

  test("the schema defines the policy of every gate relation", () => {
    const tables = Object.values(schema).filter((table) => is(table, PgTable));
    const policies = new Set(
      entityFeaturePolicyDefinitions(tables).map(({ tableName }) => tableName),
    );
    const relations = entityFeatureGateMetadata(tables).map(
      ({ tableName }) => tableName,
    );
    expect(relations.length).toBeGreaterThan(0);
    expect(relations.filter((tableName) => !policies.has(tableName))).toEqual(
      [],
    );
  });
});

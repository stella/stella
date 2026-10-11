import { expect, test } from "bun:test";

import { createTestPglite } from "@/api/tests/pglite-test-db";

import { ENTITY_FEATURE_GATE_REPAIR } from "./entity-feature-gate-repair";
import type { OnlineMigrationConnection } from "./online-migration-connection";

test("cutover completion requires the entire root list-item gate", async () => {
  const client = await createTestPglite();
  const connection: OnlineMigrationConnection = {
    execute: async (statement, params = []) => {
      await client.query(statement, [...params]);
    },
    query: async (statement, params = []) =>
      (await client.query(statement, [...params])).rows,
    release: () => {},
  };
  try {
    await client.exec(`CREATE OR REPLACE FUNCTION public.entity_feature_gate_finish()
      RETURNS void LANGUAGE sql AS 'SELECT';`);
    expect(await ENTITY_FEATURE_GATE_REPAIR.readCompletion(connection)).toEqual(
      { type: "complete" },
    );
    const feature =
      "(SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists')";
    const listItem = "list_item_type IS NULL OR list_item_type = 'task'";
    for (const expression of [
      "true",
      listItem,
      feature,
      `list_item_type IS NULL OR ${feature}`,
    ]) {
      await client.exec(`DROP POLICY workspace_entity_feature ON public.entities;
        CREATE POLICY workspace_entity_feature ON public.entities AS RESTRICTIVE
          FOR ALL TO stella USING (${expression}) WITH CHECK (${expression});`);
      expect(
        (await ENTITY_FEATURE_GATE_REPAIR.readCompletion(connection)).type,
      ).toBe("incomplete");
    }
    const complete = `(${listItem}) OR ${feature}`;
    await client.exec(`DROP POLICY workspace_entity_feature ON public.entities;
      CREATE POLICY workspace_entity_feature ON public.entities AS RESTRICTIVE
        FOR ALL TO stella USING (${complete}) WITH CHECK (${complete});`);
    expect(await ENTITY_FEATURE_GATE_REPAIR.readCompletion(connection)).toEqual(
      { type: "complete" },
    );
  } finally {
    await client.close();
  }
}, 120_000);

import { expect, test } from "bun:test";

import { effectiveEntityFeatureGateDefinitions as fold } from "./entity-feature-gate-migrations";

const trigger = (name = "entity_feature_gate_write", table = "items") =>
  `CREATE TRIGGER ${name} BEFORE UPDATE ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();`;
const policy = (name = "workspace_entity_feature", table = "items") =>
  `CREATE POLICY ${name} ON public.${table} USING (true);`;
const routine = (name = "entity_feature_gate_graph") =>
  `CREATE OR REPLACE FUNCTION public.${name}() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;`;
const index = (name = "items_ef_gate", table = "items") =>
  `CREATE INDEX ${name} ON public.${table} (id);`;
const grant = (table = "items") =>
  `GRANT SELECT (id), UPDATE (entity_feature_gate) ON TABLE public.${table} TO stella_entity_gate;`;

test("trigger drops, disable/enable, and rename follow textual order", () => {
  expect(
    fold([
      `${trigger()} DROP TRIGGER IF EXISTS entity_feature_gate_write ON items;`,
    ]).triggers.size,
  ).toBe(0);
  expect(
    fold([
      `${trigger()} ALTER TABLE items DISABLE TRIGGER entity_feature_gate_write; ALTER TABLE items ENABLE TRIGGER entity_feature_gate_write;`,
    ]).triggers.has("items.entity_feature_gate_write"),
  ).toBe(true);
  expect(
    fold([
      `${trigger()} ALTER TRIGGER entity_feature_gate_write ON items RENAME TO entity_feature_gate_new;`,
    ]).triggers.has("items.entity_feature_gate_new"),
  ).toBe(true);
});

test("drop then create leaves a trigger present", () => {
  expect(
    fold([
      `DROP TRIGGER IF EXISTS entity_feature_gate_write ON items; ${trigger()}`,
    ]).triggers.has("items.entity_feature_gate_write"),
  ).toBe(true);
});

test("policy drop, expression change, and rename are folded", () => {
  expect(
    fold([`${policy()} DROP POLICY workspace_entity_feature ON items;`])
      .policies.size,
  ).toBe(0);
  expect(
    fold([
      `${policy()} ALTER POLICY workspace_entity_feature ON items USING (false);`,
    ]).policies.get("items.workspace_entity_feature"),
  ).toContain("USING (false)");
  expect(
    fold([
      `${policy()} ALTER POLICY workspace_entity_feature ON items RENAME TO entity_feature_gate_maintenance;`,
    ]).policies.has("items.entity_feature_gate_maintenance"),
  ).toBe(true);
});

test("function drop and rename are folded", () => {
  expect(
    fold([`${routine()} DROP FUNCTION IF EXISTS entity_feature_gate_graph();`])
      .functions.size,
  ).toBe(0);
  expect(
    fold([
      `${routine()} ALTER FUNCTION entity_feature_gate_graph() RENAME TO entity_feature_gate_new;`,
    ]).functions.has("entity_feature_gate_new"),
  ).toBe(true);
});

test("index drop and rename are folded", () => {
  expect(
    fold([`${index()} DROP INDEX CONCURRENTLY IF EXISTS items_ef_gate;`])
      .indexes.size,
  ).toBe(0);
  expect(
    fold([
      `${index()} ALTER INDEX items_ef_gate RENAME TO items_ef_new;`,
    ]).indexes.has("items.items_ef_new"),
  ).toBe(true);
});

test("table grant revoke and routine revoke re-grant are folded", () => {
  expect(
    fold([`${grant()} REVOKE SELECT ON TABLE items FROM stella_entity_gate;`])
      .grants.size,
  ).toBe(0);
  const revoke = `REVOKE ALL ON FUNCTION entity_feature_gate_graph() FROM PUBLIC;`;
  expect(fold([revoke]).revokes.has("entity_feature_gate_graph()")).toBe(true);
  expect(
    fold([
      `${revoke} GRANT EXECUTE ON FUNCTION entity_feature_gate_graph() TO PUBLIC;`,
    ]).revokes.size,
  ).toBe(0);
});

test("drop table removes every table piece", () => {
  const state = fold([
    `${trigger()} ${policy()} ${index()} ${grant()} DROP TABLE IF EXISTS items;`,
  ]);
  expect([
    state.triggers.size,
    state.policies.size,
    state.indexes.size,
    state.grants.size,
  ]).toEqual([0, 0, 0, 0]);
});

test("rename table moves every table piece", () => {
  const state = fold([
    `${trigger()} ${policy()} ${index()} ${grant()} ALTER TABLE items RENAME TO renamed;`,
  ]);
  expect(state.triggers.has("renamed.entity_feature_gate_write")).toBe(true);
  expect(state.policies.has("renamed.workspace_entity_feature")).toBe(true);
  expect(state.indexes.has("renamed.items_ef_gate")).toBe(true);
  expect(state.grants.has("renamed")).toBe(true);
});

test("unknown gated-object statements fail closed with migration and SQL", () => {
  expect(() =>
    fold(["COMMENT ON TRIGGER entity_feature_gate_write ON items IS 'x';"]),
  ).toThrow(/migration 1: COMMENT ON TRIGGER entity_feature_gate_write/u);
});

test.each(["DISABLE", "ENABLE REPLICA", "ENABLE ALWAYS"])(
  "a trigger left in %s mode is not present and repairs to plain ENABLE",
  (mode) => {
    const effective = fold([
      `${trigger()} ALTER TABLE items ${mode} TRIGGER entity_feature_gate_write;`,
    ]);
    expect(effective.triggers.has("items.entity_feature_gate_write")).toBe(
      false,
    );
    expect(
      effective.disabledTriggers.has("items.entity_feature_gate_write"),
    ).toBe(true);
  },
);

test("a DO block naming a gate object is refused, whatever it does", () => {
  expect(() =>
    fold([
      `${routine("entity_feature_gate_propagate")} REVOKE ALL ON FUNCTION public.entity_feature_gate_propagate() FROM PUBLIC;`,
      "DO $$ BEGIN GRANT EXECUTE ON FUNCTION public.entity_feature_gate_propagate() TO PUBLIC; END $$;",
    ]),
  ).toThrow(/Unsupported gated DO block in migration 2/u);
});

test.each([
  "ALTER TABLE entities DISABLE TRIGGER ALL",
  "DROP TRIGGER some_trigger ON entities",
  "DROP POLICY workspace_select ON entities",
  "ALTER POLICY workspace_select ON entities USING (true)",
  "ALTER TABLE entities DISABLE ROW LEVEL SECURITY",
  "ALTER TABLE entities NO FORCE ROW LEVEL SECURITY",
  "REVOKE SELECT ON entities FROM stella",
])(
  "a DO block that can switch protection off is refused without naming a gate object: %s",
  (statement) => {
    expect(() => fold([`DO $$ BEGIN EXECUTE '${statement}'; END $$;`])).toThrow(
      /Unsupported gated DO block in migration 1/u,
    );
  },
);

test("inline gate checks on a new table do not prove its gate pieces are installed", () => {
  const create = `CREATE TABLE public.items (
    id uuid PRIMARY KEY,
    entity_feature_gate text NOT NULL DEFAULT 'pending',
    CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')),
    CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending')
  );`;
  const previous = `${trigger()} ${policy()} ${index()} ${grant()}`;
  const fresh = fold([previous, create]);
  expect([
    ...fresh.triggers,
    ...fresh.policies,
    ...fresh.indexes,
    ...fresh.grants,
  ]).toEqual([]);
  const guarded = fold([
    previous,
    create.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS"),
  ]);
  expect(guarded.triggers.has("items.entity_feature_gate_write")).toBe(true);
  expect(guarded.policies.has("items.workspace_entity_feature")).toBe(true);
  expect(guarded.indexes.has("items.items_ef_gate")).toBe(true);
  expect(guarded.grants.has("items")).toBe(true);
  const installed = fold([create, previous]);
  expect(installed.triggers.has("items.entity_feature_gate_write")).toBe(true);
  expect(installed.policies.has("items.workspace_entity_feature")).toBe(true);
});

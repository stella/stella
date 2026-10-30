import { panic } from "better-result";
import { expect, test } from "bun:test";

import { readMigrationLockSources } from "./check-migration-locks";
import { generateMigrationLockManifest } from "./generate-migration-lock-manifest";
import {
  migrationRelationLocks,
  migrationTableNames,
} from "./migration-lock-census";

const initial = {
  file: "apps/api/drizzle/20990101000000_relations/migration.sql",
  source: `
    CREATE TABLE public.alpha (id integer);
    CREATE TABLE public.beta (id integer);
    CREATE TABLE public."user" (id integer);
    CREATE TABLE public."Mixed Name" (id integer);
    CREATE INDEX alpha_idx ON ONLY public.alpha(id);
    CREATE INDEX beta_idx ON public.beta(id);
  `,
};

const targetsFor = (source: string, history = [initial]) => {
  const migration = {
    file: "apps/api/drizzle/20990101000100_operation/migration.sql",
    source,
  };
  const result =
    migrationRelationLocks([...history, migration]).at(-1) ??
    panic("Missing migration lock projection");
  return [...new Set(result.locks.map(({ target }) => target))]
    .map((target) => {
      if (target === undefined) {
        return "*";
      }
      const relation: unknown = JSON.parse(target);
      if (!Array.isArray(relation) || typeof relation.at(1) !== "string") {
        throw new TypeError("Census returned an invalid relation key");
      }
      return relation.at(1);
    })
    .toSorted();
};

test.each([
  {
    sql: 'ALTER TABLE IF EXISTS ONLY public."user" ADD COLUMN value text',
    expected: ["user"],
  },
  {
    sql: 'ALTER TABLE ONLY public."Mixed Name" ADD COLUMN IF NOT EXISTS value text',
    expected: ["Mixed Name"],
  },
  {
    sql: "CREATE TABLE IF NOT EXISTS child (alpha_id integer REFERENCES public.alpha(id))",
    expected: ["alpha", "child"],
  },
  {
    sql: "CREATE INDEX IF NOT EXISTS another_idx ON ONLY public.alpha(id)",
    expected: ["alpha"],
  },
  {
    sql: "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS another_idx ON public.alpha(id)",
    expected: ["alpha"],
  },
  { sql: "DROP INDEX IF EXISTS public.alpha_idx", expected: ["alpha"] },
  {
    sql: "DROP INDEX CONCURRENTLY IF EXISTS public.alpha_idx",
    expected: ["alpha"],
  },
  {
    sql: "DROP INDEX IF EXISTS public.alpha_idx, public.beta_idx",
    expected: ["alpha", "beta"],
  },
  {
    sql: "ALTER INDEX IF EXISTS public.alpha_idx RENAME TO alpha_renamed_idx",
    expected: ["alpha"],
  },

  { sql: "REINDEX INDEX public.alpha_idx", expected: ["alpha"] },
  { sql: "REINDEX INDEX CONCURRENTLY public.alpha_idx", expected: ["alpha"] },
  { sql: "REINDEX TABLE public.alpha", expected: ["alpha"] },
  {
    sql: "ALTER TABLE IF EXISTS public.alpha ADD CONSTRAINT alpha_check CHECK (id > 0) NOT VALID",
    expected: ["alpha"],
  },
  {
    sql: "ALTER TABLE public.alpha ADD CONSTRAINT alpha_beta_fk FOREIGN KEY (id) REFERENCES public.beta(id) NOT VALID",
    expected: ["alpha", "beta"],
  },
  {
    sql: "ALTER TABLE public.alpha DROP CONSTRAINT IF EXISTS alpha_check",
    expected: ["alpha"],
  },
  {
    sql: "ALTER TABLE ONLY public.alpha VALIDATE CONSTRAINT alpha_check",
    expected: ["alpha"],
  },
  {
    sql: "CREATE OR REPLACE TRIGGER alpha_trigger BEFORE INSERT ON public.alpha FOR EACH ROW EXECUTE FUNCTION trigger_fn()",
    expected: ["alpha"],
  },
  {
    sql: "CREATE CONSTRAINT TRIGGER alpha_trigger AFTER INSERT ON public.alpha FOR EACH ROW EXECUTE FUNCTION trigger_fn()",
    expected: ["alpha"],
  },
  {
    sql: "DROP TRIGGER IF EXISTS alpha_trigger ON public.alpha",
    expected: ["alpha"],
  },
  {
    sql: "CREATE OR REPLACE VIEW combined AS SELECT alpha.id FROM public.alpha JOIN public.beta ON beta.id = alpha.id",
    expected: ["*", "alpha", "beta"],
  },
  {
    sql: "CREATE OR REPLACE VIEW combined AS SELECT a.id FROM public.alpha AS a, public.beta b",
    expected: ["*", "alpha", "beta"],
  },
  {
    sql: "ALTER TABLE public.alpha RENAME TO renamed_alpha",
    expected: ["*", "renamed_alpha"],
  },
  { sql: "COMMENT ON TABLE public.alpha IS 'metadata'", expected: ["alpha"] },
  { sql: "ANALYZE public.alpha", expected: ["alpha"] },
  {
    sql: "LOCK TABLE ONLY public.alpha IN ACCESS EXCLUSIVE MODE",
    expected: ["alpha"],
  },
  { sql: "DROP INDEX IF EXISTS index_without_known_parent", expected: ["*"] },
  { sql: "ALTER TABLE unknown_table ADD COLUMN value text", expected: ["*"] },
])(
  "relation lease targets resolve to owning tables: $sql",
  ({ sql, expected }) => {
    expect(targetsFor(sql)).toEqual(expected);
  },
);

test("index ownership follows table and index renames across migration history", () => {
  expect(
    targetsFor(`
    ALTER TABLE alpha RENAME TO renamed_alpha;
    ALTER INDEX alpha_idx RENAME TO renamed_idx;
    REINDEX INDEX renamed_idx;
    DROP INDEX renamed_idx;
  `),
  ).toEqual(["*", "renamed_alpha"]);
});

test("an index with a renamed owner reserves former table lease names", () => {
  const rename = {
    file: "apps/api/drizzle/20990101000030_rename/migration.sql",
    source: "ALTER TABLE alpha RENAME TO renamed_alpha;",
  };
  expect(targetsFor("DROP INDEX alpha_idx;", [initial, rename])).toEqual([
    "*",
    "renamed_alpha",
  ]);
});

test("every real manifest target names a surviving public table or an explicit wildcard", () => {
  const sources = readMigrationLockSources();
  const tables = migrationTableNames(sources);
  const manifest = generateMigrationLockManifest(sources);
  const relations = Object.values(manifest.migrations).flatMap(({ locks }) =>
    locks.map(({ relation }) => relation),
  );
  expect(relations.length).toBeGreaterThan(0);
  expect(
    relations.filter(
      (relation) =>
        relation !== "*" && !tables.some((table) => table === relation),
    ),
  ).toEqual([]);
  expect(relations).not.toContain("if");
  expect(relations).not.toContain("number_series_org_type_default_uidx");
  expect(
    manifest.migrations[
      "20261003123500_number_series_seller_scope"
    ]?.locks.some(
      ({ relation, mode }) =>
        relation === "number_series" && mode === "ACCESS EXCLUSIVE",
    ),
  ).toBe(true);
});

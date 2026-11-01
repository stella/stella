import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import { INVOICE_SEND_UPDATE_COLUMNS } from "@/api/db/schema";
import { getPgErrorCode } from "@/api/lib/pg-error";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { withIsolatedPostgresCluster } from "@/api/tests/isolated-postgres-cluster";

import { runMigrations } from "../../db/migration-runner";
import {
  assertCompleteCensus,
  type Census,
  readExpectedCensus,
  readRolePrivilegeCensus,
} from "./role-privilege-census";

const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const describePostgres = describe.skipIf(!runPostgresTests);
const migrationsFolder = path.resolve(import.meta.dir, "../../../drizzle");

type BodyToken =
  { type: "name"; name: string } | { type: "symbol"; symbol: string };

// Comments, string literals and dollar-quoted strings name nothing the body
// resolves, so they are dropped; quoted identifiers keep their case.
const BODY_TOKEN =
  /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|\$(?<tag>[A-Za-z_]\w*)?\$[\s\S]*?\$\k<tag>\$|"(?<quoted>(?:[^"]|"")+)"|(?<bare>[A-Za-z_][\w$]*)|(?<symbol>\S)/gu;

const tokenizeBody = (source: string): BodyToken[] =>
  [...source.matchAll(BODY_TOKEN)].flatMap(({ groups }): BodyToken[] => {
    const { quoted, bare, symbol } = groups ?? {};
    if (quoted !== undefined) {
      return [{ type: "name", name: quoted.replaceAll('""', '"') }];
    }
    if (bare !== undefined) {
      return [{ type: "name", name: bare.toLowerCase() }];
    }
    if (symbol !== undefined) {
      return [{ type: "symbol", symbol }];
    }
    return [];
  });

const nameAt = (tokens: BodyToken[], index: number) => {
  const token = tokens.at(index);
  return index >= 0 && token?.type === "name" ? token.name : undefined;
};

const symbolAt = (tokens: BodyToken[], index: number) => {
  const token = tokens.at(index);
  return index >= 0 && token?.type === "symbol" ? token.symbol : undefined;
};

const WRITE_EVENTS = {
  insert: ["insert"],
  update: ["update"],
  delete: ["delete"],
  merge: ["insert", "update", "delete"],
  truncate: ["truncate"],
} as const;
type WriteVerb = keyof typeof WRITE_EVENTS;
type RelationEvent = (typeof WRITE_EVENTS)[WriteVerb][number] | "read";
const isWriteVerb = (word: string | undefined): word is WriteVerb =>
  word !== undefined && Object.hasOwn(WRITE_EVENTS, word);

/** Columns an `UPDATE public.x [alias] SET ...` assigns; null when unknown. */
const updatedColumns = (tokens: BodyToken[], relationIndex: number) => {
  let index = relationIndex + 1;
  if (nameAt(tokens, index) === "as") {
    index += 1;
  }
  if (nameAt(tokens, index) !== "set") {
    index += 1;
  }
  if (nameAt(tokens, index) !== "set" || symbolAt(tokens, index + 1) === "(") {
    return null;
  }
  const columns: string[] = [];
  let depth = 0;
  for (index += 1; index < tokens.length; index += 1) {
    const symbol = symbolAt(tokens, index);
    if (symbol === "(") {
      depth += 1;
    }
    if (symbol === ")") {
      depth -= 1;
    }
    if (symbol === ";" || depth < 0) {
      break;
    }
    const name = nameAt(tokens, index);
    if (depth > 0 || name === undefined) {
      continue;
    }
    if (["from", "where", "returning"].includes(name)) {
      break;
    }
    if (symbolAt(tokens, index + 1) === "=") {
      columns.push(name);
    }
  }
  return columns;
};

const statementUpserts = (tokens: BodyToken[], relationIndex: number) => {
  for (let index = relationIndex; index < tokens.length; index += 1) {
    if (symbolAt(tokens, index) === ";") {
      return false;
    }
    if (
      nameAt(tokens, index) === "do" &&
      nameAt(tokens, index + 1) === "update"
    ) {
      return true;
    }
  }
  return false;
};

type BodyFunction = {
  oid: number;
  name: string;
  signature: string;
  source: string;
  definer: boolean;
};
type RelationFunction = {
  relation: number;
  function: number;
  event: RelationEvent;
  /** A column trigger's columns; empty when any update fires it. */
  columns: string[];
};
type ForeignKeyAction = {
  parent: number;
  child: number;
  event: "update" | "delete";
  action: "update" | "delete";
};
type SearchPathFinding = { function: string; name: string; route: string };

// Static rather than a live temporary-table shadow: definers run as triggers,
// behind arguments only their callers can build, or through the functions and
// triggers their writes reach, so no generic execution covers every body. The
// catalog does. Starting at every public SECURITY DEFINER function, this walks
// each SQL or PL/pgSQL body that can run under its pinned search path (calls to
// public functions, triggers its writes fire, constraint, default and index
// functions of written relations, policy and view functions of named ones, and
// foreign-key actions) and reports every public relation, type or function the
// body names without `public.`. Under `pg_catalog, pg_temp` such a name fails
// or resolves to a caller's temporary relation of the same name. EXECUTE
// strings are not followed: dynamic SQL must format qualified names itself.
const readSearchPathDependentReferences = async (
  database: SQL,
): Promise<SearchPathFinding[]> => {
  const functions = await database.unsafe<BodyFunction[]>(`
    SELECT procedure.oid::int AS oid, procedure.proname AS name,
      procedure.proname || '(' || pg_catalog.pg_get_function_identity_arguments(procedure.oid) || ')' AS signature,
      procedure.prosrc AS source, procedure.prosecdef AS definer
    FROM pg_catalog.pg_proc procedure
    JOIN pg_catalog.pg_language language ON language.oid = procedure.prolang
    WHERE procedure.pronamespace = 'public'::regnamespace
      AND language.lanname IN ('sql', 'plpgsql')
  `);
  const publicNames = new Set(
    (
      await database.unsafe<{ name: string }[]>(`
        SELECT relname AS name FROM pg_catalog.pg_class
        WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'v', 'm', 'f', 'S', 'c')
        UNION SELECT typname FROM pg_catalog.pg_type WHERE typnamespace = 'public'::regnamespace
        UNION SELECT proname FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace
      `)
    ).map(({ name }) => name),
  );
  const relations = new Map(
    (
      await database.unsafe<{ name: string; oid: number }[]>(`
        SELECT relname AS name, oid::int AS oid FROM pg_catalog.pg_class
        WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'v', 'm', 'f')
      `)
    ).map(({ name, oid }) => [name, oid]),
  );
  const relationFunctions = await database.unsafe<RelationFunction[]>(`
    SELECT trigger.tgrelid::int AS relation, trigger.tgfoid::int AS function, event.name AS event,
      ARRAY(SELECT attribute.attname::text FROM pg_catalog.pg_attribute attribute
            WHERE attribute.attrelid = trigger.tgrelid AND attribute.attnum = ANY (trigger.tgattr)) AS columns
    FROM pg_catalog.pg_trigger trigger
    CROSS JOIN (VALUES (4, 'insert'), (8, 'delete'), (16, 'update'), (32, 'truncate')) event(bit, name)
    WHERE NOT trigger.tgisinternal AND trigger.tgtype & event.bit <> 0
    UNION ALL
    SELECT owner.relation, dependency.refobjid::int, owner.event, ARRAY[]::text[]
    FROM pg_catalog.pg_depend dependency
    CROSS JOIN LATERAL (
      SELECT constraint_row.conrelid::int AS relation, write.event
      FROM pg_catalog.pg_constraint constraint_row, (VALUES ('insert'), ('update')) write(event)
      WHERE dependency.classid = 'pg_catalog.pg_constraint'::regclass
        AND constraint_row.oid = dependency.objid AND constraint_row.contype <> 'f'
      UNION ALL
      SELECT default_row.adrelid::int, write.event
      FROM pg_catalog.pg_attrdef default_row, (VALUES ('insert'), ('update')) write(event)
      WHERE dependency.classid = 'pg_catalog.pg_attrdef'::regclass AND default_row.oid = dependency.objid
      UNION ALL
      SELECT index_row.indrelid::int, write.event
      FROM pg_catalog.pg_index index_row, (VALUES ('insert'), ('update')) write(event)
      WHERE dependency.classid = 'pg_catalog.pg_class'::regclass AND index_row.indexrelid = dependency.objid
      UNION ALL
      SELECT policy.polrelid::int, 'read' FROM pg_catalog.pg_policy policy
      WHERE dependency.classid = 'pg_catalog.pg_policy'::regclass AND policy.oid = dependency.objid
      UNION ALL
      SELECT rewrite.ev_class::int, 'read' FROM pg_catalog.pg_rewrite rewrite
      WHERE dependency.classid = 'pg_catalog.pg_rewrite'::regclass AND rewrite.oid = dependency.objid
    ) owner
    WHERE dependency.refclassid = 'pg_catalog.pg_proc'::regclass
  `);
  const foreignKeyActions = await database.unsafe<ForeignKeyAction[]>(`
    SELECT constraint_row.confrelid::int AS parent, constraint_row.conrelid::int AS child,
      referenced.event, CASE referenced.action WHEN 'c' THEN referenced.event ELSE 'update' END AS action
    FROM pg_catalog.pg_constraint constraint_row
    CROSS JOIN LATERAL (VALUES ('delete', constraint_row.confdeltype), ('update', constraint_row.confupdtype))
      referenced(event, action)
    WHERE constraint_row.contype = 'f' AND referenced.action IN ('c', 'n', 'd')
  `);

  const byOid = new Map(functions.map((entry) => [entry.oid, entry]));
  const byName = Map.groupBy(functions, ({ name }) => name);
  const queue = functions
    .filter(({ definer }) => definer)
    .map((entry) => ({ entry, route: entry.signature }));
  const reached = new Set<number>();
  const touched = new Set<string>();
  const touch = (
    relation: number,
    event: RelationEvent,
    columns: string[] | null,
    route: string,
  ) => {
    const key = `${relation}:${event}:${columns?.join(",") ?? "*"}`;
    if (touched.has(key)) {
      return;
    }
    touched.add(key);
    for (const edge of relationFunctions) {
      if (edge.relation !== relation) {
        continue;
      }
      if (edge.event !== event && edge.event !== "read") {
        continue;
      }
      const columnFiltered =
        event === "update" &&
        columns !== null &&
        edge.columns.length > 0 &&
        !edge.columns.some((column) => columns.includes(column));
      const target = byOid.get(edge.function);
      if (columnFiltered || target === undefined) {
        continue;
      }
      queue.push({
        entry: target,
        route: `${route} -> ${event} fires ${target.signature}`,
      });
    }
    for (const foreignKey of foreignKeyActions) {
      if (foreignKey.parent === relation && foreignKey.event === event) {
        touch(foreignKey.child, foreignKey.action, null, route);
      }
    }
  };

  const findings = new Map<string, SearchPathFinding>();
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const { entry, route } = next;
    if (reached.has(entry.oid)) {
      continue;
    }
    reached.add(entry.oid);
    const tokens = tokenizeBody(entry.source);
    for (const [index, token] of tokens.entries()) {
      if (token.type !== "name") {
        continue;
      }
      if (
        symbolAt(tokens, index - 1) === "." &&
        nameAt(tokens, index - 2) === "public"
      ) {
        if (symbolAt(tokens, index + 1) === "(") {
          for (const callee of byName.get(token.name) ?? []) {
            queue.push({
              entry: callee,
              route: `${route} -> ${callee.signature}`,
            });
          }
        }
        const relation = relations.get(token.name);
        if (relation === undefined) {
          continue;
        }
        touch(relation, "read", null, route);
        let verbIndex = index - 3;
        while (
          ["only", "into", "from", "table"].includes(
            nameAt(tokens, verbIndex) ?? "",
          )
        ) {
          verbIndex -= 1;
        }
        const verb = nameAt(tokens, verbIndex);
        if (!isWriteVerb(verb)) {
          continue;
        }
        for (const event of WRITE_EVENTS[verb]) {
          touch(
            relation,
            event,
            event === "update" && verb === "update"
              ? updatedColumns(tokens, index)
              : null,
            route,
          );
        }
        if (verb === "insert" && statementUpserts(tokens, index)) {
          touch(relation, "update", null, route);
        }
        continue;
      }
      const qualifier =
        symbolAt(tokens, index - 1) === "." ||
        symbolAt(tokens, index + 1) === ".";
      if (qualifier || !publicNames.has(token.name)) {
        continue;
      }
      const key = `${entry.signature}:${token.name}`;
      if (!findings.has(key)) {
        findings.set(key, {
          function: entry.signature,
          name: token.name,
          route,
        });
      }
    }
  }
  return [...findings.values()];
};

const withMigratedDatabase = async (
  run: (database: SQL, census: Census) => Promise<void>,
) => {
  await withIsolatedPostgresCluster(
    {
      prefix: "role-census",
      database: "stella",
      user: "census_admin",
      password: "fixture",
    },
    async (scratchUrl) => {
      await withGatedTestClients(scratchUrl, async ({ openClient }) => {
        const database = openClient().sql;
        const connection = await database.reserve();
        try {
          await runMigrations({
            connection,
            databaseUrl: scratchUrl,
            migrationsFolder,
            ebs: { type: "disabled" },
          });
        } finally {
          await connection.release();
        }
        await run(database, await readRolePrivilegeCensus(database));
      });
    },
  );
};

describePostgres("database role privilege census", () => {
  // timeout: verifies the catalog after applying every migration in an isolated cluster.
  test("pins every live security definer function to trusted schemas", async () => {
    await withMigratedDatabase(async (database) => {
      const functions = await database.unsafe<
        { signature: string; search_path: string | null }[]
      >(`
        SELECT procedure.oid::regprocedure::text AS signature,
          (SELECT setting FROM pg_catalog.unnest(procedure.proconfig) setting
           WHERE setting LIKE 'search_path=%') AS search_path
        FROM pg_catalog.pg_proc procedure
        WHERE procedure.prosecdef
        ORDER BY signature
      `);
      expect(functions.length).toBeGreaterThan(0);
      expect(
        functions.filter(
          ({ search_path }) =>
            search_path !== "search_path=pg_catalog, pg_temp",
        ),
      ).toEqual([]);
      expect(await readSearchPathDependentReferences(database)).toEqual([]);
      expect(
        await database.unsafe(`
        SELECT public.case_law_provision_extraction_in_scope('ZZP', 'xtrusted') AS in_scope,
          public.ensure_case_law_provision_extraction_state('{}'::uuid[], 'seed') AS written,
          public.run_case_law_provision_scope_transition_page('ZZP', 'xtrusted', 1) AS advanced
      `),
      ).toEqual([{ in_scope: false, written: 0, advanced: false }]);
      expect(
        await database.unsafe(`
        SELECT availability FROM public.read_case_law_provision_pending('ZZP', 'xtrusted', '{}'::text[])
      `),
      ).toEqual([{ availability: "scope_inactive" }]);
      await database.unsafe(`
        INSERT INTO public.case_law_sources (id, adapter_key, name)
        VALUES ('00000000-0000-4000-8000-000000000001', 'trusted-path-fixture', 'Test source');
        INSERT INTO public.case_law_decisions
          (id, source_id, country, language, court, case_number, decision_date, metadata)
        VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
          'ZZP', 'xtrusted', 'Court', '1', '2020-03-01', '{}'::jsonb);
      `);
      expect(
        await database.unsafe(`
        SELECT status FROM public.case_law_provision_extraction_scopes
        WHERE country = 'ZZP' AND language = 'xtrusted'
      `),
      ).toEqual([{ status: "retired" }]);
      await database.unsafe(`
        UPDATE public.case_law_decisions SET projection_epoch = projection_epoch + 1
        WHERE id = '00000000-0000-4000-8000-000000000002';
        INSERT INTO public.corpus_index_generations (family, generation, cluster, manifest_digest, status)
        VALUES ('case_law', 'case_law_v999998', 'q09', repeat('a', 64), 'retiring'),
          ('case_law', 'case_law_v999997', 'q09', repeat('a', 64), 'retired');
        INSERT INTO public.corpus_index_projection_states (family, generation, entity_id, desired_action, desired_epoch)
        SELECT generation.family, generation.generation, decision.id, 'erase', decision.projection_epoch
        FROM public.corpus_index_generations generation CROSS JOIN public.case_law_decisions decision
        WHERE generation.generation IN ('case_law_v999998', 'case_law_v999997')
          AND decision.id = '00000000-0000-4000-8000-000000000002';
      `);
      expect(
        await database.unsafe(`
        SELECT * FROM public.purge_rebuilding_corpus_index_projection_history('case_law', 'case_law_v999998', 1)
        UNION ALL
        SELECT * FROM public.purge_retired_corpus_index_projection_history('case_law', 'case_law_v999997', 1)
      `),
      ).toEqual([
        { deleted_state_count: 1, deleted_intent_count: 0 },
        { deleted_state_count: 1, deleted_intent_count: 0 },
      ]);

      // A definer whose write fires a trigger that names a public table
      // without its schema: the probe reports it, and a temporary table of
      // that name captures the trigger's write.
      await database.unsafe(`
        CREATE TABLE public.search_path_probe_rows (id integer);
        CREATE TABLE public.search_path_probe_log (id integer);
        CREATE FUNCTION public.search_path_probe_log_row() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO search_path_probe_log VALUES (NEW.id);
          RETURN NEW;
        END
        $$;
        CREATE TRIGGER search_path_probe_log_row AFTER INSERT ON public.search_path_probe_rows
          FOR EACH ROW EXECUTE FUNCTION public.search_path_probe_log_row();
        CREATE FUNCTION public.search_path_probe_write() RETURNS void LANGUAGE sql
          SECURITY DEFINER SET search_path = pg_catalog, pg_temp
          AS $$ INSERT INTO public.search_path_probe_rows VALUES (1) $$;
      `);
      expect(await readSearchPathDependentReferences(database)).toEqual([
        {
          function: "search_path_probe_log_row()",
          name: "search_path_probe_log",
          route:
            "search_path_probe_write() -> insert fires search_path_probe_log_row()",
        },
      ]);
      expect(
        await database.begin(async (tx) => {
          await tx.unsafe(
            "CREATE TEMP TABLE search_path_probe_log (id integer) ON COMMIT DROP",
          );
          await tx.unsafe("SELECT public.search_path_probe_write()");
          return tx.unsafe(`
            SELECT (SELECT count(*)::int FROM pg_temp.search_path_probe_log) AS shadowed,
              (SELECT count(*)::int FROM public.search_path_probe_log) AS stored
          `);
        }),
      ).toEqual([{ shadowed: 1, stored: 0 }]);
    });
  }, 120_000);

  // timeout: initializing PostgreSQL and applying the complete migration chain is the behavior under test.
  test("matches every migrated role and effective privilege", async () => {
    const expected = readExpectedCensus();
    await withMigratedDatabase(async (database, actual) => {
      try {
        assertCompleteCensus(expected, actual);
      } catch (error) {
        throw new Error(
          'Database role privilege census is stale. Run `PATH="/usr/lib/postgresql/18/bin:$PATH" bun apps/api/scripts/update-role-privilege-census.ts` and review the changes.',
          { cause: error },
        );
      }
      // Column grants intentionally do not count as a table-wide UPDATE.
      const invoiceSendColumns = await database.unsafe(`
        SELECT attribute.attname AS column
        FROM pg_catalog.pg_attribute attribute
        WHERE attribute.attrelid = 'public.invoice_sends'::regclass
          AND attribute.attnum > 0 AND NOT attribute.attisdropped
          AND pg_catalog.has_column_privilege('stella', attribute.attrelid, attribute.attnum, 'UPDATE')
        ORDER BY attribute.attname
      `);
      expect(invoiceSendColumns).toEqual(
        INVOICE_SEND_UPDATE_COLUMNS.map(({ name }) => name)
          .toSorted()
          .map((column) => ({ column })),
      );
      expect(
        await database.unsafe(`SELECT
        has_function_privilege('stella', 'public.stella_chat_run_text_boundaries()', 'EXECUTE') AS runtime,
        has_function_privilege('stella_public_law_reader', 'public.stella_chat_run_text_boundaries()', 'EXECUTE') AS reader`),
      ).toEqual([{ runtime: true, reader: false }]);
      const denied = await rejectionOf(
        database.begin(async (tx) => {
          await tx.unsafe("SET LOCAL ROLE stella_public_law_reader");
          await tx.unsafe("SELECT public.stella_chat_run_text_boundaries()");
        }),
      );
      expect(getPgErrorCode(denied)).toBe("42501");
    });
  }, 120_000);

  // timeout: the self-test applies the complete migration chain before mutating its census fixture.
  test("reports disabled row-level security", async () => {
    const expected = readExpectedCensus();
    await withMigratedDatabase(async (database, baseline) => {
      assertCompleteCensus(expected, baseline);
      try {
        await database.unsafe(
          `ALTER TABLE public.account_audit_logs DISABLE ROW LEVEL SECURITY`,
        );
        const mutated = await readRolePrivilegeCensus(database);
        expect(() => assertCompleteCensus(expected, mutated)).toThrow(
          "stella table:public.account_audit_logs:RLS_ENABLED:false",
        );
      } finally {
        await database.unsafe(
          `ALTER TABLE public.account_audit_logs ENABLE ROW LEVEL SECURITY`,
        );
      }
    });
  }, 120_000);

  // timeout: the self-test applies the complete migration chain before mutating its census fixture.
  test("reports a sequence UPDATE grant", async () => {
    const expected = readExpectedCensus();
    await withMigratedDatabase(async (database, baseline) => {
      assertCompleteCensus(expected, baseline);
      const role = `stella_census_fixture_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      try {
        await database.unsafe(
          `CREATE ROLE "${role}" NOLOGIN; GRANT UPDATE ON SEQUENCE public.corpus_index_projection_revisions_revision_seq TO "${role}"`,
        );
        const mutated = await readRolePrivilegeCensus(database);
        expect(() => assertCompleteCensus(expected, mutated)).toThrow(
          `${role} sequence:public.corpus_index_projection_revisions_revision_seq:UPDATE:GRANTABLE:false`,
        );
      } finally {
        await database.unsafe(
          `DROP OWNED BY "${role}"; DROP ROLE IF EXISTS "${role}"`,
        );
      }
    });
  }, 120_000);

  // timeout: the self-test applies the complete migration chain before mutating its census fixture.
  test("reports a role granted CREATEDB", async () => {
    const expected = readExpectedCensus();
    await withMigratedDatabase(async (database, baseline) => {
      assertCompleteCensus(expected, baseline);
      const role = `stella_census_fixture_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      try {
        await database.unsafe(`CREATE ROLE "${role}" CREATEDB NOLOGIN`);
        const mutated = await readRolePrivilegeCensus(database);
        expect(() => assertCompleteCensus(expected, mutated)).toThrow(
          `${role} attribute:CREATEDB:true`,
        );
      } finally {
        await database.unsafe(`DROP ROLE IF EXISTS "${role}"`);
      }
    });
  }, 120_000);

  // timeout: the self-test applies the complete migration chain before mutating its census fixture.
  test("reports a role granted REPLICATION", async () => {
    const expected = readExpectedCensus();
    await withMigratedDatabase(async (database, baseline) => {
      assertCompleteCensus(expected, baseline);
      const role = `stella_census_fixture_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      try {
        await database.unsafe(`CREATE ROLE "${role}" REPLICATION NOLOGIN`);
        const mutated = await readRolePrivilegeCensus(database);
        expect(() => assertCompleteCensus(expected, mutated)).toThrow(
          `${role} attribute:REPLICATION:true`,
        );
      } finally {
        await database.unsafe(`DROP ROLE IF EXISTS "${role}"`);
      }
    });
  }, 120_000);

  // timeout: the self-test applies the complete migration chain before mutating its census fixture.
  test("reports a membership changed to WITH ADMIN OPTION", async () => {
    const expected = readExpectedCensus();
    await withMigratedDatabase(async (database, baseline) => {
      assertCompleteCensus(expected, baseline);
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const parent = `stella_census_parent_${suffix}`;
      const member = `stella_census_member_${suffix}`;
      try {
        await database.unsafe(`
          CREATE ROLE "${parent}" NOLOGIN;
          CREATE ROLE "${member}" NOLOGIN;
          GRANT "${parent}" TO "${member}";
        `);
        const withoutAdminOption = await readRolePrivilegeCensus(database);
        await database.unsafe(
          `GRANT "${parent}" TO "${member}" WITH ADMIN OPTION`,
        );
        const withAdminOption = await readRolePrivilegeCensus(database);
        expect(() =>
          assertCompleteCensus(withoutAdminOption, withAdminOption),
        ).toThrow(
          `${member} membership:${parent}:ADMIN_OPTION:true:INHERIT_OPTION:true:SET_OPTION:true`,
        );
      } finally {
        await database.unsafe(`
          REVOKE "${parent}" FROM "${member}";
          DROP ROLE IF EXISTS "${member}";
          DROP ROLE IF EXISTS "${parent}";
        `);
      }
    });
  }, 120_000);

  // timeout: the self-test applies the complete migration chain before mutating its census fixture.
  test("reports a column-level grant", async () => {
    const expected = readExpectedCensus();
    await withMigratedDatabase(async (database, baseline) => {
      assertCompleteCensus(expected, baseline);
      const role = `stella_census_fixture_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      try {
        await database.unsafe(
          `CREATE ROLE "${role}" NOLOGIN; GRANT SELECT (id) ON TABLE public.account TO "${role}"`,
        );
        const mutated = await readRolePrivilegeCensus(database);
        expect(() => assertCompleteCensus(expected, mutated)).toThrow(
          `${role} column:public.account.id:SELECT:GRANTABLE:false`,
        );
      } finally {
        await database.unsafe(
          `DROP OWNED BY "${role}"; DROP ROLE IF EXISTS "${role}"`,
        );
      }
    });
  }, 120_000);

  // timeout: the self-test applies the complete migration chain before mutating its census fixture.
  test("reports an aggregate EXECUTE grant", async () => {
    const expected = readExpectedCensus();
    await withMigratedDatabase(async (database, baseline) => {
      assertCompleteCensus(expected, baseline);
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const role = `stella_census_fixture_${suffix}`;
      const aggregate = `stella_census_fixture_${suffix}`;
      try {
        await database.unsafe(`
          CREATE ROLE "${role}" NOLOGIN;
          CREATE AGGREGATE public."${aggregate}" (integer) (
            SFUNC = pg_catalog.int4pl,
            STYPE = integer,
            INITCOND = '0'
          );
          REVOKE ALL ON FUNCTION public."${aggregate}"(integer) FROM PUBLIC;
          GRANT EXECUTE ON FUNCTION public."${aggregate}"(integer) TO "${role}"
        `);
        const mutated = await readRolePrivilegeCensus(database);
        expect(() => assertCompleteCensus(expected, mutated)).toThrow(
          `${role} function:public.${aggregate}(integer):EXECUTE:GRANTABLE:false`,
        );
      } finally {
        await database.unsafe(`
          DROP AGGREGATE IF EXISTS public."${aggregate}"(integer);
          DROP OWNED BY "${role}";
          DROP ROLE IF EXISTS "${role}"
        `);
      }
    });
  }, 120_000);

  // timeout: the self-test applies the complete migration chain before mutating its census fixture.
  test("reports policies for a column-only grantee", async () => {
    const expected = readExpectedCensus();
    await withMigratedDatabase(async (database, baseline) => {
      assertCompleteCensus(expected, baseline);
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const role = `stella_census_fixture_${suffix}`;
      const table = `stella_census_fixture_${suffix}`;
      const policy = `stella_census_fixture_${suffix}`;
      try {
        await database.unsafe(`
          CREATE ROLE "${role}" NOLOGIN;
          CREATE TABLE public."${table}" (id integer PRIMARY KEY);
          ALTER TABLE public."${table}" ENABLE ROW LEVEL SECURITY;
          CREATE POLICY "${policy}" ON public."${table}" FOR SELECT TO "${role}" USING (true);
          GRANT SELECT (id) ON TABLE public."${table}" TO "${role}"
        `);
        const mutated = await readRolePrivilegeCensus(database);
        expect(() => assertCompleteCensus(expected, mutated)).toThrow(
          `${role} table:public.${table}:POLICY:${policy}`,
        );
      } finally {
        await database.unsafe(`
          DROP TABLE IF EXISTS public."${table}";
          DROP OWNED BY "${role}";
          DROP ROLE IF EXISTS "${role}"
        `);
      }
    });
  }, 120_000);

  // timeout: the self-test applies the complete migration chain before mutating its census fixture.
  test("reports a new row-level security policy", async () => {
    const expected = readExpectedCensus();
    await withMigratedDatabase(async (database, baseline) => {
      assertCompleteCensus(expected, baseline);
      const policy = `stella_census_fixture_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      try {
        await database.unsafe(
          `CREATE POLICY "${policy}" ON public.account_audit_logs AS PERMISSIVE FOR SELECT TO stella USING (false)`,
        );
        const mutated = await readRolePrivilegeCensus(database);
        expect(() => assertCompleteCensus(expected, mutated)).toThrow(
          `stella table:public.account_audit_logs:POLICY:${policy}`,
        );
      } finally {
        await database.unsafe(
          `DROP POLICY IF EXISTS "${policy}" ON public.account_audit_logs`,
        );
      }
    });
  }, 120_000);

  // timeout: the self-test applies the complete migration chain before mutating its census fixture.
  test("reports a changed row-level security USING predicate", async () => {
    const expected = readExpectedCensus();
    await withMigratedDatabase(async (database, baseline) => {
      assertCompleteCensus(expected, baseline);
      try {
        await database.unsafe(
          `ALTER POLICY account_audit_logs_select ON public.account_audit_logs USING (true)`,
        );
        const mutated = await readRolePrivilegeCensus(database);
        expect(() => assertCompleteCensus(expected, mutated)).toThrow(
          "POLICY:account_audit_logs_select:COMMAND:SELECT:ROLES:public:PERMISSIVE:PERMISSIVE:USING:true:WITH_CHECK:NULL",
        );
      } finally {
        await database.unsafe(
          `ALTER POLICY account_audit_logs_select ON public.account_audit_logs USING (user_id = (SELECT current_setting('app.user_id', true)))`,
        );
      }
    });
  }, 120_000);

  // timeout: the self-test applies the complete migration chain before mutating its census fixture.
  test("reports a changed row-level security WITH CHECK predicate", async () => {
    const expected = readExpectedCensus();
    await withMigratedDatabase(async (database, baseline) => {
      assertCompleteCensus(expected, baseline);
      try {
        await database.unsafe(
          `ALTER POLICY account_audit_logs_insert ON public.account_audit_logs WITH CHECK (true)`,
        );
        const mutated = await readRolePrivilegeCensus(database);
        expect(() => assertCompleteCensus(expected, mutated)).toThrow(
          "POLICY:account_audit_logs_insert:COMMAND:INSERT:ROLES:stella:PERMISSIVE:PERMISSIVE:USING:NULL:WITH_CHECK:true",
        );
      } finally {
        await database.unsafe(
          `ALTER POLICY account_audit_logs_insert ON public.account_audit_logs WITH CHECK (user_id = (SELECT current_setting('app.user_id', true)))`,
        );
      }
    });
  }, 120_000);
});

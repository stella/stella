import { getTableConfig } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";

import {
  entityFeatureGateGraphSql,
  entityFeatureGatePropagationSql,
} from "../src/db/entity-feature-gate-metadata";
import type { EntityFeatureGateDescriptor } from "../src/db/entity-feature-gate-metadata";
import type { EffectiveEntityFeatureGateDefinitions } from "../src/db/entity-feature-gate-migrations";
import { entityFeaturePolicyDefinitions } from "../src/db/entity-feature-policies";

const breakpoint = "\n--> statement-breakpoint\n";
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

/**
 * A policy's CREATE POLICY statement, spelled as `online-ddl` spells it. The
 * generator writes migration text and must not load the online DDL runner;
 * a test pins this to `online-ddl`'s rendering.
 */
type GatePolicy = ReturnType<typeof entityFeaturePolicyDefinitions>[number];

export const createPolicyStatement = ({
  tableName,
  name,
  as,
  for: command,
  role,
  using,
  withCheck,
}: GatePolicy): string =>
  `CREATE POLICY ${quote(name)} ON "public".${quote(tableName)} AS ${as.toUpperCase()} FOR ${command.toUpperCase()} TO ${quote(role)}${
    using === undefined ? "" : ` USING (${using})`
  }${withCheck === undefined ? "" : ` WITH CHECK (${withCheck})`};`;

const checkStatements = ({ tableName }: EntityFeatureGateDescriptor) => [
  `DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.${tableName}'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public.${quote(tableName)} ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$;`,
  `DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.${tableName}'::regclass AND conname = 'entity_feature_gate_ready_check') THEN ALTER TABLE public.${quote(tableName)} ADD CONSTRAINT entity_feature_gate_ready_check CHECK (entity_feature_gate <> 'pending') NOT VALID; END IF; END $check$;`,
];

const trigger = (table: string, name: string, body: string) => {
  const row =
    name === "entity_feature_gate_write" ||
    name === "entity_feature_gate_repair_missing";
  const routine = row ? name : "entity_feature_gate_propagate";
  const condition =
    name === "entity_feature_gate_repair_missing"
      ? "WHEN (NEW.entity_feature_gate = 'missing') "
      : "";
  const referencingAt = body.indexOf(" REFERENCING ");
  const event = referencingAt === -1 ? body : body.slice(0, referencingAt);
  const transitionRelations =
    referencingAt === -1
      ? undefined
      : body.slice(referencingAt + " REFERENCING ".length);
  return `CREATE TRIGGER ${name} ${event} ON public.${quote(table)}${transitionRelations === undefined ? "" : ` REFERENCING ${transitionRelations}`} FOR EACH ${row ? "ROW" : "STATEMENT"} ${condition}EXECUTE FUNCTION public.${routine}();`;
};

const PROPAGATION_TRIGGERS = [
  [
    "entity_feature_gate_insert",
    "AFTER INSERT REFERENCING NEW TABLE AS entity_feature_new_rows",
  ],
  [
    "entity_feature_gate_update",
    "AFTER UPDATE REFERENCING OLD TABLE AS entity_feature_old_rows NEW TABLE AS entity_feature_new_rows",
  ],
  [
    "entity_feature_gate_delete",
    "AFTER DELETE REFERENCING OLD TABLE AS entity_feature_old_rows",
  ],
] as const;

/**
 * Routines the gate role owns: the gate migration created them under
 * `SET LOCAL ROLE stella_entity_gate`, and only an owner may replace a
 * routine or change its privileges.
 */
const GATE_ROLE_ROUTINES: ReadonlySet<string> = new Set([
  "entity_feature_gate_value",
  "entity_feature_gate_write",
  "entity_feature_gate_propagate",
  "entity_feature_gate_repair_missing",
  "entity_feature_gate_backfill",
]);

/**
 * Statements run as the gate role. The gate migration leaves the migrator a
 * member of it WITH SET FALSE, so the switch is granted around them and
 * withdrawn after, exactly as that migration did.
 */
const asGateRole = (statements: readonly string[]): string[] => [
  "GRANT stella_entity_gate TO CURRENT_USER WITH SET TRUE;",
  "SET LOCAL ROLE stella_entity_gate;",
  ...statements,
  "RESET ROLE;",
  "GRANT stella_entity_gate TO CURRENT_USER WITH SET FALSE;",
];

/**
 * A routine's replacement statements, run as the role that owns it. The gate
 * role holds no CREATE on the schema outside a replacement, so it is granted
 * for it and revoked after, as the gate migration did.
 */
export const routineReplacementSql = (
  name: string,
  statements: readonly string[],
): string[] =>
  GATE_ROLE_ROUTINES.has(name)
    ? [
        "GRANT CREATE ON SCHEMA public TO stella_entity_gate;",
        ...asGateRole(statements),
        "REVOKE CREATE ON SCHEMA public FROM stella_entity_gate;",
      ]
    : [...statements];

/** The routines a gate trigger executes. */
const TRIGGER_ROUTINES =
  "public.entity_feature_gate_write(), public.entity_feature_gate_propagate(), public.entity_feature_gate_repair_missing()";

/**
 * Creating a trigger needs EXECUTE on its routine, which PUBLIC lacks. As the
 * gate migration did, the routines' owner grants the migrating session
 * EXECUTE before the first CREATE TRIGGER and revokes it after the last.
 */
const withTriggerExecute = (statements: readonly string[]): string[] => {
  const creates = (statement: string) =>
    statement.startsWith("CREATE TRIGGER ");
  const first = statements.findIndex(creates);
  if (first === -1) {
    return [...statements];
  }
  const last = statements.findLastIndex(creates);
  return [
    ...statements.slice(0, first),
    ...asGateRole([
      `GRANT EXECUTE ON FUNCTION ${TRIGGER_ROUTINES} TO SESSION_USER;`,
    ]),
    ...statements.slice(first, last + 1),
    ...asGateRole([
      `REVOKE EXECUTE ON FUNCTION ${TRIGGER_ROUTINES} FROM SESSION_USER;`,
    ]),
    ...statements.slice(last + 1),
  ];
};

/** The routines derived from the census, by name. */
export const entityFeatureGateRoutines = (
  descriptors: readonly EntityFeatureGateDescriptor[],
) =>
  [
    ["entity_feature_gate_graph", entityFeatureGateGraphSql(descriptors)],
    [
      "entity_feature_gate_propagate",
      entityFeatureGatePropagationSql(descriptors),
    ],
  ] as const;

/**
 * The routine signatures the gate migration revoked from PUBLIC. A gate
 * routine's privileges are their own piece: re-granting one to PUBLIC leaves
 * its definition unchanged.
 */
const GATE_ROUTINE_SIGNATURES: ReadonlyMap<string, string> = new Map([
  ["entity_feature_gate_graph", "entity_feature_gate_graph()"],
  ["entity_feature_gate_value", "entity_feature_gate_value(text, jsonb)"],
  ["entity_feature_gate_write", "entity_feature_gate_write()"],
  ["entity_feature_gate_propagate", "entity_feature_gate_propagate()"],
  [
    "entity_feature_gate_repair_missing",
    "entity_feature_gate_repair_missing()",
  ],
  [
    "entity_feature_gate_backfill",
    "entity_feature_gate_backfill(text, text, integer)",
  ],
  ["entity_feature_gate_finish", "entity_feature_gate_finish()"],
]);

/**
 * Where one gate piece stands in migration history:
 * - `present`: as the census derives it;
 * - `absent`: not there, so it is created;
 * - `stale`: a routine whose definition differs, so it is replaced;
 * - `disabled`: a trigger that exists but does not fire, so it is enabled;
 * - `over-granted`: a routine PUBLIC may execute again, so it is revoked.
 */
type GatePieceState =
  "present" | "absent" | "stale" | "disabled" | "over-granted";

type GatePiece = {
  /** `kind:table.name` or `kind:name`, unique per piece. */
  id: string;
  state: GatePieceState;
  /** The statements that bring the piece to `present`; empty when present. */
  repair: readonly string[];
};

const piece = (
  id: string,
  state: GatePieceState,
  repair: () => readonly string[],
): GatePiece => ({ id, state, repair: state === "present" ? [] : repair() });

const triggerPiece = (
  effective: EffectiveEntityFeatureGateDefinitions,
  table: string,
  name: string,
  create: () => string,
): GatePiece => {
  const key = `${table}.${name}`;
  if (effective.triggers.has(key)) {
    return piece(`trigger:${key}`, "present", () => []);
  }
  // A disabled trigger still exists under its name: CREATE would fail.
  return effective.disabledTriggers.has(key)
    ? piece(`trigger:${key}`, "disabled", () => [
        `ALTER TABLE public.${quote(table)} ENABLE TRIGGER ${name};`,
      ])
    : piece(`trigger:${key}`, "absent", () => [create()]);
};

const routineState = (
  stored: string | undefined,
  derived: string,
): GatePieceState => {
  if (stored === undefined) {
    return "absent";
  }
  return stored === derived ? "present" : "stale";
};

const routinePieces = (
  descriptors: readonly EntityFeatureGateDescriptor[],
  effective: EffectiveEntityFeatureGateDefinitions,
): GatePiece[] => {
  const pieces: GatePiece[] = entityFeatureGateRoutines(descriptors).map(
    ([name, sql]) => {
      const stored = effective.functions.get(name);
      return piece(`routine:${name}`, routineState(stored, sql), () =>
        routineReplacementSql(name, [sql]),
      );
    },
  );
  const derived: ReadonlySet<string> = new Set(
    entityFeatureGateRoutines(descriptors).map(([name]) => name),
  );
  for (const [name, signature] of GATE_ROUTINE_SIGNATURES) {
    // A routine history no longer has, and the generator does not create,
    // has no privileges to restore.
    if (!effective.functions.has(name) && !derived.has(name)) {
      continue;
    }
    pieces.push(
      piece(
        `revoke:${signature}`,
        effective.revokes.has(signature) ? "present" : "over-granted",
        () =>
          routineReplacementSql(name, [
            `REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC;`,
          ]),
      ),
    );
  }
  return pieces;
};

const grantStatement = (descriptor: EntityFeatureGateDescriptor) => {
  const selected = [
    ...new Set([
      ...[...descriptor.projection.matchAll(/'([^']+)', p\."([^"]+)"/gu)].map(
        (match) => match[2] ?? "",
      ),
      ...descriptor.primaryKey,
    ]),
  ];
  const updated = [
    "entity_feature_gate",
    ...(descriptor.needsWorkspace ? ["entity_feature_workspace_ids"] : []),
    ...(descriptor.needsOrganization
      ? ["entity_feature_organization_ids"]
      : []),
  ];
  return `GRANT SELECT (${selected.map(quote).join(", ")}), UPDATE (${updated.map(quote).join(", ")}) ON public.${quote(descriptor.tableName)} TO stella_entity_gate;`;
};

const ROW_TRIGGERS = [
  ["entity_feature_gate_write", "BEFORE INSERT OR UPDATE"],
  ["entity_feature_gate_repair_missing", "AFTER INSERT OR UPDATE"],
] as const;

/** Each gated table's own pieces: checks, policies, row triggers, grant. */
const tablePieces = (
  tables: readonly PgTable[],
  descriptor: EntityFeatureGateDescriptor,
  effective: EffectiveEntityFeatureGateDefinitions,
): GatePiece[] => {
  const { tableName } = descriptor;
  const policies = (
    ["workspace_entity_feature", "entity_feature_gate_maintenance"] as const
  ).flatMap((policyName) =>
    entityFeaturePolicyDefinitions(tables, policyName)
      .filter((policy) => policy.tableName === tableName)
      .map((policy) =>
        piece(
          `policy:${tableName}.${policyName}`,
          effective.policies.has(`${tableName}.${policyName}`)
            ? "present"
            : "absent",
          () => [createPolicyStatement(policy)],
        ),
      ),
  );
  // The root of the graph derives its gate from its own columns and is
  // never `missing`, so only children carry the repair trigger.
  const triggers = ROW_TRIGGERS.filter(
    ([name]) =>
      name === "entity_feature_gate_write" || descriptor.refs.length > 0,
  ).map(([name, timing]) =>
    triggerPiece(effective, tableName, name, () =>
      trigger(tableName, name, timing),
    ),
  );
  const grant = piece(
    `grant:${tableName}`,
    effective.grants.has(tableName) ? "present" : "absent",
    () => [grantStatement(descriptor)],
  );
  const own = [...policies, ...triggers, grant];
  // The gate checks are idempotent DO blocks a table being gated needs once.
  const gating = own.some(({ state }) => state === "absent");
  return [
    piece(`checks:${tableName}`, gating ? "absent" : "present", () =>
      checkStatements(descriptor),
    ),
    ...own,
  ];
};

const indexPieces = (
  tables: readonly PgTable[],
  gated: ReadonlySet<string>,
  effective: EffectiveEntityFeatureGateDefinitions,
): GatePiece[] =>
  tables.flatMap((table) => {
    const config = getTableConfig(table);
    if (!gated.has(config.name)) {
      return [];
    }
    return config.indexes.flatMap((index) => {
      const { name, columns, unique, method } = index.config;
      if (name === undefined || !name.includes("_ef_")) {
        return [];
      }
      const key = `${config.name}.${name}`;
      const columnNames = columns.flatMap((column) =>
        "name" in column ? [quote(column.name)] : [],
      );
      return [
        piece(
          `index:${key}`,
          effective.indexes.has(key) ? "present" : "absent",
          () => [
            `COMMIT;${breakpoint}DROP INDEX CONCURRENTLY IF EXISTS public.${quote(name)};${breakpoint}CREATE ${unique ? "UNIQUE " : ""}INDEX CONCURRENTLY ${quote(name)} ON public.${quote(config.name)}${method && method !== "btree" ? ` USING ${method}` : ""} (${columnNames.join(", ")});${breakpoint}BEGIN;`,
          ],
        ),
      ];
    });
  });

/**
 * Every gate piece the census requires, with its state in migration
 * history. Each piece is judged and repaired on its own, so one missing,
 * disabled or over-granted piece never hides behind a present neighbour.
 * Ordered as the migration must run them: routines and their privileges,
 * then each table's pieces, the parents' propagation triggers, and last the
 * concurrent index builds, which leave the migration's transaction.
 */
export const entityFeatureGatePieces = (
  tables: readonly PgTable[],
  descriptors: readonly EntityFeatureGateDescriptor[],
  effective: EffectiveEntityFeatureGateDefinitions,
): GatePiece[] => {
  const parents = new Set(
    descriptors.flatMap(({ refs }) => refs.map(({ parent }) => parent)),
  );
  return [
    ...routinePieces(descriptors, effective),
    ...descriptors.flatMap((descriptor) =>
      tablePieces(tables, descriptor, effective),
    ),
    ...[...parents].flatMap((parent) =>
      PROPAGATION_TRIGGERS.map(([name, timing]) =>
        triggerPiece(effective, parent, name, () =>
          trigger(parent, name, timing),
        ),
      ),
    ),
    ...indexPieces(
      tables,
      new Set(descriptors.map(({ tableName }) => tableName)),
      effective,
    ),
  ];
};

/** The additive migration statements: every piece's repair, in order. */
export const entityFeatureGateTableSql = (
  tables: readonly PgTable[],
  descriptors: readonly EntityFeatureGateDescriptor[],
  effective: EffectiveEntityFeatureGateDefinitions,
): string[] =>
  withTriggerExecute(
    entityFeatureGatePieces(tables, descriptors, effective).flatMap(
      ({ repair }) => [...repair],
    ),
  );

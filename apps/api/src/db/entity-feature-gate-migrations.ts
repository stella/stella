import { panic } from "better-result";
import { readdir } from "node:fs/promises";

import { compareCodeUnit } from "@stll/collation";
import { sha256Hex } from "@stll/sha256/bun";

export type EffectiveEntityFeatureGateDefinitions = {
  functions: ReadonlyMap<string, string>;
  policies: ReadonlyMap<string, string>;
  triggers: ReadonlyMap<string, string>;
  /** Triggers that exist but are disabled: enabling them restores them. */
  disabledTriggers: ReadonlySet<string>;
  indexes: ReadonlyMap<string, string>;
  grants: ReadonlyMap<string, string>;
  revokes: ReadonlySet<string>;
};

const statementKey = (table: string, name: string) => `${table}.${name}`;

const splitStatements = (sql: string) => {
  const result: string[] = [];
  let start = 0;
  let quote = "";
  let dollar = "";
  let lineComment = false;
  for (let i = 0; i < sql.length; i += 1) {
    if (lineComment) {
      if (sql[i] === "\n") {
        lineComment = false;
      }
      continue;
    }
    if (dollar) {
      if (sql.startsWith(dollar, i)) {
        i += dollar.length - 1;
        dollar = "";
      }
      continue;
    }
    if (quote) {
      if (sql[i] === quote && sql[i + 1] === quote) {
        i += 1;
      } else if (sql[i] === quote) {
        quote = "";
      }
      continue;
    }
    if (sql.startsWith("--", i)) {
      lineComment = true;
      i += 1;
      continue;
    }
    if (sql[i] === "'" || sql[i] === '"') {
      quote = sql[i] ?? "";
      continue;
    }
    const tag = /^\$[a-z0-9_]*\$/iu.exec(sql.slice(i))?.[0];
    if (tag) {
      dollar = tag;
      i += tag.length - 1;
      continue;
    }
    const breakpoint = "--> statement-breakpoint";
    if (sql.startsWith(breakpoint, i) || sql[i] === ";") {
      const end = sql[i] === ";" ? i + 1 : i;
      const statement = sql.slice(start, end).trim();
      if (statement) {
        result.push(statement);
      }
      if (sql.startsWith(breakpoint, i)) {
        i += breakpoint.length - 1;
      }
      start = i + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail) {
    result.push(tail);
  }
  return result;
};
/** The statement without the line and block comments that lead it. */
const clean = (sql: string) => {
  let rest = sql.trimStart();
  for (;;) {
    if (rest.startsWith("--")) {
      const end = rest.indexOf("\n");
      rest = end === -1 ? "" : rest.slice(end + 1).trimStart();
    } else if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/");
      rest = end === -1 ? "" : rest.slice(end + 2).trimStart();
    } else {
      return rest.trim();
    }
  }
};
const id = '"?([a-z0-9_]+)"?';
const tableId = `(?:(?:"?public"?)\\.)?${id}`;
type FoldState = {
  functions: Map<string, string>;
  policies: Map<string, string>;
  /** Triggers that exist, enabled or not; `triggers` holds the enabled ones. */
  knownTriggers: Map<string, string>;
  triggers: Map<string, string>;
  indexes: Map<string, string>;
  grants: Map<string, string>;
  revokes: Set<string>;
};

type StatementHandler = {
  pattern: RegExp;
  apply: (state: FoldState, match: RegExpExecArray, sql: string) => void;
};

const POLICY_NAMES = "workspace_entity_feature|entity_feature_gate_maintenance";
const GATE_INDEX = "[a-z0-9_]*(?:entity_feature|_ef_)[a-z0-9_]*";
const GATE_TRIGGER = "entity_feature_gate_[a-z0-9_]+";
const GATE_ROUTINE = `(?:"?public"?\\.)?"?(entity_feature_gate_[a-z0-9_]+)"?`;
const ROUTINE_SIGNATURE =
  /(?:public\.)?(entity_feature_gate_[a-z0-9_]+\([^)]*\))/giu;
const pattern = (source: string) => new RegExp(source, "iu");
const group = (match: RegExpExecArray, index: number) => match[index] ?? "";

type MapField =
  | "functions"
  | "policies"
  | "knownTriggers"
  | "triggers"
  | "indexes"
  | "grants";
const TABLE_FIELDS = [
  "policies",
  "triggers",
  "knownTriggers",
  "indexes",
] as const satisfies readonly MapField[];

/** Drop the matching keys of one field; true when any was there. */
const forget = (
  state: FoldState,
  field: MapField,
  drop: (key: string) => boolean,
): boolean => {
  const entries = state[field];
  const kept = [...entries].filter(([key]) => !drop(key));
  const removed = kept.length < entries.size;
  entries.clear();
  for (const [key, value] of kept) {
    entries.set(key, value);
  }
  return removed;
};

const forgetSignatures = (
  state: FoldState,
  drop: (signature: string) => boolean,
) => {
  state.revokes = new Set([...state.revokes].filter((value) => !drop(value)));
};

/** Re-key one field's entries from one table to another. */
const moveTable = (
  state: FoldState,
  field: MapField,
  from: string,
  to: string,
) => {
  const entries = state[field];
  const moved = [...entries].map(([key, value]): [string, string] =>
    key.startsWith(`${from}.`)
      ? [`${to}.${key.slice(from.length + 1)}`, value]
      : [key, value],
  );
  entries.clear();
  for (const [key, value] of moved) {
    entries.set(key, value);
  }
};

const forgetRevokes = (state: FoldState, routine: string) =>
  forgetSignatures(state, (signature) => signature.startsWith(`${routine}(`));

const renameRoutine = (
  state: FoldState,
  from: string,
  to: string,
  sql: string,
) => {
  if (forget(state, "functions", (key) => key === from)) {
    state.functions.set(to, sql);
  }
  state.revokes = new Set(
    [...state.revokes].map((signature) =>
      signature.startsWith(`${from}(`)
        ? `${to}${signature.slice(from.length)}`
        : signature,
    ),
  );
};

const renameTrigger = (
  state: FoldState,
  from: string,
  to: string,
  sql: string,
) => {
  const enabled = forget(state, "triggers", (key) => key === from);
  if (forget(state, "knownTriggers", (key) => key === from)) {
    state.knownTriggers.set(to, sql);
  }
  if (enabled) {
    state.triggers.set(to, sql);
  }
};

const toggleTriggers = (
  state: FoldState,
  table: string,
  target: string,
  enable: boolean,
) => {
  for (const [key, definition] of state.knownTriggers) {
    const all = target === "ALL" || target === "USER";
    if (
      key.startsWith(`${table}.`) &&
      (all || key === statementKey(table, target))
    ) {
      if (enable) {
        state.triggers.set(key, definition);
      } else {
        forget(state, "triggers", (candidate) => candidate === key);
      }
    }
  }
};

const dropTable = (state: FoldState, table: string) => {
  for (const field of TABLE_FIELDS) {
    forget(state, field, (key) => key.startsWith(`${table}.`));
  }
  forget(state, "grants", (key) => key === table);
};

const renameTable = (state: FoldState, from: string, to: string) => {
  for (const field of TABLE_FIELDS) {
    moveTable(state, field, from, to);
  }
  const grant = state.grants.get(from);
  if (grant !== undefined && forget(state, "grants", (key) => key === from)) {
    state.grants.set(to, grant);
  }
};

/** Every statement form that creates, changes or removes a gated object. */
const STATEMENT_HANDLERS: readonly StatementHandler[] = [
  {
    pattern: pattern(
      `^CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${GATE_ROUTINE}\\s*\\(`,
    ),
    apply: (state, match, sql) => state.functions.set(group(match, 1), sql),
  },
  {
    pattern: pattern(
      `^DROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?${GATE_ROUTINE}\\s*\\(`,
    ),
    apply: (state, match) => {
      const name = group(match, 1);
      forget(state, "functions", (key) => key === name);
      forgetRevokes(state, name);
    },
  },
  {
    pattern: pattern(
      `^ALTER\\s+FUNCTION\\s+${GATE_ROUTINE}\\s*\\([^)]*\\)\\s+RENAME\\s+TO\\s+"?([a-z0-9_]+)"?`,
    ),
    apply: (state, match, sql) =>
      renameRoutine(state, group(match, 1), group(match, 2), sql),
  },
  {
    pattern: pattern(
      `^CREATE\\s+POLICY\\s+"?(${POLICY_NAMES})"?\\s+ON\\s+${tableId}`,
    ),
    apply: (state, match, sql) =>
      state.policies.set(statementKey(group(match, 2), group(match, 1)), sql),
  },
  {
    pattern: pattern(
      `^DROP\\s+POLICY\\s+(?:IF\\s+EXISTS\\s+)?"?(${POLICY_NAMES})"?\\s+ON\\s+${tableId}`,
    ),
    apply: (state, match) =>
      forget(
        state,
        "policies",
        (key) => key === statementKey(group(match, 2), group(match, 1)),
      ),
  },
  {
    // A changed expression replaces the stored statement; a rename moves it.
    pattern: pattern(
      `^ALTER\\s+POLICY\\s+"?(${POLICY_NAMES})"?\\s+ON\\s+${tableId}(?:\\s+RENAME\\s+TO\\s+"?([a-z0-9_]+)"?)?`,
    ),
    apply: (state, match, sql) => {
      const table = group(match, 2);
      forget(
        state,
        "policies",
        (key) => key === statementKey(table, group(match, 1)),
      );
      state.policies.set(statementKey(table, match[3] ?? group(match, 1)), sql);
    },
  },
  {
    pattern: pattern(
      `^CREATE\\s+(?:CONSTRAINT\\s+)?TRIGGER\\s+"?(${GATE_TRIGGER})"?[\\s\\S]*?\\s+ON\\s+${tableId}`,
    ),
    apply: (state, match, sql) => {
      const key = statementKey(group(match, 2), group(match, 1));
      state.knownTriggers.set(key, sql);
      state.triggers.set(key, sql);
    },
  },
  {
    pattern: pattern(
      `^DROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?"?(${GATE_TRIGGER})"?\\s+ON\\s+${tableId}`,
    ),
    apply: (state, match) => {
      const key = statementKey(group(match, 2), group(match, 1));
      forget(state, "knownTriggers", (candidate) => candidate === key);
      forget(state, "triggers", (candidate) => candidate === key);
    },
  },
  {
    // Only plain ENABLE fires for application writes: DISABLE does not fire,
    // and ENABLE REPLICA or ALWAYS change when it fires. Anything but plain
    // ENABLE counts as not present and is repaired to plain ENABLE.
    pattern: pattern(
      `^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${tableId}\\s+(DISABLE|ENABLE(?:\\s+ALWAYS|\\s+REPLICA)?)\\s+TRIGGER\\s+(ALL|USER|"?${GATE_TRIGGER}"?)`,
    ),
    apply: (state, match) =>
      toggleTriggers(
        state,
        group(match, 1),
        group(match, 3).replaceAll('"', ""),
        group(match, 2).toUpperCase() === "ENABLE",
      ),
  },
  {
    pattern: pattern(
      `^ALTER\\s+TRIGGER\\s+"?(${GATE_TRIGGER})"?\\s+ON\\s+${tableId}\\s+RENAME\\s+TO\\s+"?([a-z0-9_]+)"?`,
    ),
    apply: (state, match, sql) =>
      renameTrigger(
        state,
        statementKey(group(match, 2), group(match, 1)),
        statementKey(group(match, 2), group(match, 3)),
        sql,
      ),
  },
  {
    pattern: pattern(
      `^CREATE\\s+(?:UNIQUE\\s+)?INDEX(?:\\s+CONCURRENTLY)?(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+"?(${GATE_INDEX})"?\\s+ON\\s+(?:ONLY\\s+)?${tableId}`,
    ),
    apply: (state, match, sql) =>
      state.indexes.set(statementKey(group(match, 2), group(match, 1)), sql),
  },
  {
    pattern: pattern(
      `^DROP\\s+INDEX(?:\\s+CONCURRENTLY)?(?:\\s+IF\\s+EXISTS)?\\s+(?:"?public"?\\.)?"?(${GATE_INDEX})"?`,
    ),
    apply: (state, match) =>
      forget(state, "indexes", (key) => key.endsWith(`.${group(match, 1)}`)),
  },
  {
    pattern: pattern(
      `^ALTER\\s+INDEX\\s+(?:IF\\s+EXISTS\\s+)?(?:"?public"?\\.)?"?(${GATE_INDEX})"?\\s+RENAME\\s+TO\\s+"?([a-z0-9_]+)"?`,
    ),
    apply: (state, match, sql) => {
      state.indexes = new Map(
        [...state.indexes].map(([key, value]) =>
          key.endsWith(`.${group(match, 1)}`)
            ? [`${key.slice(0, key.lastIndexOf("."))}.${group(match, 2)}`, sql]
            : [key, value],
        ),
      );
    },
  },
  {
    pattern: pattern(
      `^GRANT\\s+[\\s\\S]+?\\s+ON\\s+(?:TABLE\\s+)?${tableId}\\s+TO\\s+stella_entity_gate\\b`,
    ),
    apply: (state, match, sql) => state.grants.set(group(match, 1), sql),
  },
  {
    pattern: pattern(
      `^REVOKE\\s+[\\s\\S]+?\\s+ON\\s+(?:TABLE\\s+)?${tableId}\\s+FROM\\s+stella_entity_gate\\b`,
    ),
    apply: (state, match) =>
      forget(state, "grants", (key) => key === group(match, 1)),
  },
  {
    pattern: pattern(
      `^REVOKE\\s+[\\s\\S]+?\\bON\\s+FUNCTION\\s+[\\s\\S]+?\\bFROM\\s+PUBLIC\\b`,
    ),
    apply: (state, _match, sql) => {
      for (const signature of sql.matchAll(ROUTINE_SIGNATURE)) {
        state.revokes.add(signature[1] ?? "");
      }
    },
  },
  {
    pattern: pattern(
      `^GRANT\\s+[\\s\\S]+?\\bON\\s+FUNCTION\\s+[\\s\\S]+?\\bTO\\s+PUBLIC\\b`,
    ),
    apply: (state, _match, sql) => {
      for (const signature of sql.matchAll(ROUTINE_SIGNATURE)) {
        forgetSignatures(state, (value) => value === (signature[1] ?? ""));
      }
    },
  },
  {
    pattern: pattern(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${tableId}`),
    apply: (state, match) => dropTable(state, group(match, 1)),
  },
  {
    pattern: pattern(
      `^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${tableId}\\s+RENAME\\s+TO\\s+${id}`,
    ),
    apply: (state, match) =>
      renameTable(state, group(match, 1), group(match, 2)),
  },
];

/** Statements that name gated objects without creating, changing or removing one. */
const NEUTRAL_STATEMENTS: readonly ((sql: string) => boolean)[] = [
  (sql) => /^GRANT\s+stella_entity_gate\s+TO/iu.test(sql),
  (sql) => /\bON\s+SCHEMA\b/iu.test(sql),
  // Role switches inside a gate routine's body.
  (sql) => /^(?:SET|RESET)\s+(?:LOCAL\s+)?ROLE\b/iu.test(sql),
  // Routine execute grants to roles other than PUBLIC do not change revokes.
  (sql) =>
    /^(?:GRANT|REVOKE)\b/iu.test(sql) &&
    /\bON\s+FUNCTION\b/iu.test(sql) &&
    !/\b(?:FROM|TO)\s+PUBLIC\b/iu.test(sql),
];

const GATED_OBJECT =
  /entity_feature_gate_[a-z0-9_]+|workspace_entity_feature|entity_feature_gate_maintenance|(?:GRANT|REVOKE)[\s\S]+ON[\s\S]+stella_entity_gate|(?:entity_feature|_ef_)[a-z0-9_]*\s+(?:ON|RENAME)/iu;
// A DO block's effect is not folded, so one that names a gate object is
// refused, except two reviewed forms: the gate check constraints the
// generator writes for a newly gated table, and the gate migration's role
// and ownership setup, pinned by content.
const NAMES_GATE_OBJECT =
  /entity_feature_gate|workspace_entity_feature|stella_entity_gate|_ef_/iu;
const GATE_CHECK_BLOCK =
  /^DO \$check\$ BEGIN IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conrelid = 'public\.[a-z0-9_]+'::regclass AND conname = 'entity_feature_gate_(?:states|ready)_check'\) THEN ALTER TABLE public\."[a-z0-9_]+" ADD CONSTRAINT entity_feature_gate_(?:states_check CHECK \(entity_feature_gate IN \('pending', 'open', 'legal-lists', 'missing'\)\)|ready_check CHECK \(entity_feature_gate <> 'pending'\)) NOT VALID; END IF; END \$check\$;?$/u;
const REVIEWED_DO_BLOCK_DIGESTS: ReadonlySet<string> = new Set([
  // 20261009112500_entity_feature_row_gates: the gate role ($role$) and the
  // gated tables' ownership check ($ownership$).
  "2cc1de9651dce4678295ae32a0be83b4e543aed1d09da1770e8bbea7f3310c8b",
  "bf691151d21554b79204533029c538cbfbf4b52d6c28703bc9bdef51292c9347",
  // Applied before any gate existed, and they use a verb refused below:
  // 20260510140000_document_rls_role_bootstrap (a role membership REVOKE)
  // and 20260710173000_scalable_workspace_authorization (workspace policy
  // ALTER POLICY rewrites).
  "dedb2e145a86faef1fbe76a0d93d5be6cecc270d661b2a7140033d3b54ffd4ae",
  "2be38411cd78c08ad531cf21933c83888caf0f43cc19423eab215761e6b096cb",
  "98af32848d5183ef91136e04532f8572b4e4974b20d863251e7c24dbf4c02440",
  "91a20eb72b45d1efca1bb3233686d785cac8861e88e0bf0900b1115721a20b23",
]);

// A DO block can switch a gated table's protection off without naming a
// gate object (DISABLE TRIGGER ALL, NO FORCE ROW LEVEL SECURITY, DROP
// POLICY on it), so these verbs are refused in any DO block that is not
// pinned above, whatever it names.
const DO_BLOCK_PROTECTION_VERBS =
  /\b(?:DISABLE\s+TRIGGER|DROP\s+TRIGGER|DROP\s+POLICY|ALTER\s+POLICY|DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY|REVOKE)\b/iu;

/** A DO block's content digest, whitespace-insensitive. */
const doBlockDigest = (sql: string): string =>
  sha256Hex(sql.replace(/\s+/gu, " ").trim());

const isReviewedGateDoBlock = (sql: string) =>
  GATE_CHECK_BLOCK.test(sql) ||
  REVIEWED_DO_BLOCK_DIGESTS.has(doBlockDigest(sql));

/** Inline the policy DDL the gate migration's finish routine runs when called. */
const withFinishBody = (statement: string): string[] => {
  if (
    !/^CREATE OR REPLACE FUNCTION public\.entity_feature_gate_finish\(/mu.test(
      clean(statement),
    )
  ) {
    return [statement];
  }
  const body = statement.split("$finish$").at(1) ?? "";
  const firstGateDdl = body.search(/(?:DROP|CREATE) POLICY/iu);
  return firstGateDdl === -1
    ? [statement]
    : [statement, ...splitStatements(body.slice(firstGateDdl))];
};

/** One migration's statements as the fold reads them, in order. */
const foldedStatements = (migration: string): string[] =>
  splitStatements(migration)
    .flatMap(withFinishBody)
    .map((raw) =>
      clean(raw)
        .replace(/^END;?/iu, "")
        .trim(),
    );

const foldStatement = (state: FoldState, sql: string, migration: number) => {
  for (const handler of STATEMENT_HANDLERS) {
    const match = handler.pattern.exec(sql);
    if (match) {
      handler.apply(state, match, sql);
      return;
    }
  }
  if (/^DO\s/iu.test(sql)) {
    if (
      (NAMES_GATE_OBJECT.test(sql) || DO_BLOCK_PROTECTION_VERBS.test(sql)) &&
      !isReviewedGateDoBlock(sql)
    ) {
      panic(`Unsupported gated DO block in migration ${migration}: ${sql}`);
    }
    return;
  }
  if (NEUTRAL_STATEMENTS.some((neutral) => neutral(sql))) {
    return;
  }
  if (GATED_OBJECT.test(sql)) {
    panic(
      `Unsupported gated object statement in migration ${migration}: ${sql}`,
    );
  }
};

/**
 * Fold migrations in application order and each migration in statement order,
 * so a drop and a re-creation resolve as written. A statement that touches a
 * gated object in a form this fold does not know fails closed.
 */
export const effectiveEntityFeatureGateDefinitions = (
  migrations: readonly string[],
): EffectiveEntityFeatureGateDefinitions => {
  const state: FoldState = {
    functions: new Map(),
    policies: new Map(),
    knownTriggers: new Map(),
    triggers: new Map(),
    indexes: new Map(),
    grants: new Map(),
    revokes: new Set(),
  };
  for (const [index, migration] of migrations.entries()) {
    for (const sql of foldedStatements(migration)) {
      foldStatement(state, sql, index + 1);
    }
  }
  const { functions, policies, triggers, indexes, grants, revokes } = state;
  const disabledTriggers = new Set(
    [...state.knownTriggers.keys()].filter((key) => !triggers.has(key)),
  );
  return {
    functions,
    policies,
    triggers,
    disabledTriggers,
    indexes,
    grants,
    revokes,
  };
};

/** Every migration's text, in application order. */
export const readEntityFeatureGateMigrationTexts = async (
  drizzleUrl = new URL("../../drizzle/", import.meta.url),
): Promise<string[]> => {
  const entries = (await readdir(drizzleUrl, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name)
    .toSorted(compareCodeUnit);
  const migrations: string[] = [];
  for (const entry of entries) {
    const file = Bun.file(new URL(`${entry}/migration.sql`, drizzleUrl));
    if (await file.exists()) {
      migrations.push(await file.text());
    }
  }
  return migrations;
};

export const readEffectiveEntityFeatureGateDefinitions = async (
  drizzleUrl = new URL("../../drizzle/", import.meta.url),
) =>
  effectiveEntityFeatureGateDefinitions(
    await readEntityFeatureGateMigrationTexts(drizzleUrl),
  );

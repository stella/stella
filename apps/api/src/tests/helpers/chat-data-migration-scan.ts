// Whether a migration, as it runs, writes rows of a chat table.
//
// A migration's SQL is read as PostgreSQL reads it: comments are dropped,
// and quoted text (single quotes, double quotes, dollar quotes of any tag) is
// consumed as a unit, so a `;` or a keyword inside a body never splits or
// hides a statement. Each top-level statement is then one of two things.
//
// - A routine definition (`CREATE [OR REPLACE] FUNCTION | PROCEDURE`). The
//   migration stores its body and does not run it, so the rows the body
//   writes are not counted as written by the migration. The routine is
//   remembered as chat-writing when its body writes a chat table or calls a
//   chat-writing routine.
// - Any other statement, which the migration runs. It counts when
//   - its text, bodies and string literals included, writes a chat table (a
//     `DO` block runs its body; dynamic SQL in a string counts as written),
//   - it names a chat-writing routine with a call's parenthesis, unless the
//     statement only refers to the routine (`CREATE TRIGGER`, `GRANT`,
//     `REVOKE`, `ALTER`, `COMMENT ON`, `DROP` of a routine), or
//   - it writes rows of a table on which a trigger runs a chat-writing
//     routine, whatever the trigger's event.
//
// Chat-writing routines and their triggers are collected over every
// migration, so a routine one migration defines and a later one calls counts
// in the later one. Not expressible here: a routine reached only through a
// name built at run time, and a routine redefined later with a body that no
// longer writes chat rows still counts (the scan errs toward counting).

const ROUTINE_DEFINITION =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+([\w."]+)/iu;
const TRIGGER_DEFINITION =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s[\s\S]*?\sON\s+(?:ONLY\s+)?([\w."]+)[\s\S]*?\sEXECUTE\s+(?:FUNCTION|PROCEDURE)\s+([\w."]+)/iu;
/** Statements that name a routine without running it. */
const ROUTINE_REFERENCE =
  /^\s*(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s|GRANT\s|REVOKE\s|COMMENT\s+ON\s|(?:ALTER|DROP)\s+(?:FUNCTION|PROCEDURE|ROUTINE)\s)/iu;
const DOLLAR_TAG = /\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/uy;
const IDENTIFIER_CHARACTER = /[\w$]/u;

/** `public."chat_turns"` and `Chat_Turns` both name `chat_turns`. */
const bareName = (qualified: string): string =>
  (qualified.split(".").at(-1) ?? qualified).replaceAll('"', "").toLowerCase();

const escaped = (name: string) =>
  name.replaceAll(/[.*+?^${}()|[\]\\]/gu, (character) => `\\${character}`);

const writesTable = (statement: string, table: string): boolean =>
  new RegExp(
    String.raw`\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM|MERGE\s+INTO|COPY|TRUNCATE(\s+TABLE)?)\s+(ONLY\s+)?("?public"?\.)?"?${escaped(table)}"?(\s|\(|;|'|$)`,
    "imu",
  ).test(statement);

const callsRoutine = (statement: string, routine: string): boolean =>
  new RegExp(String.raw`(^|[^\w$])"?${escaped(routine)}"?\s*\(`, "imu").test(
    statement,
  );

/**
 * The top-level statements of `source`, without comments. Quoted text is
 * kept whole inside its statement.
 */
export const sqlStatementsOf = (source: string): string[] => {
  const statements: string[] = [];
  let current = "";
  let index = 0;
  const take = (end: number) => {
    current += source.slice(index, end);
    index = end;
  };
  /** The index after the quote that closes the one opened at `index`. */
  const closingOf = (quote: string): number => {
    let at = index + 1;
    for (;;) {
      const next = source.indexOf(quote, at);
      if (next === -1) {
        return source.length;
      }
      // A doubled quote is the quote character itself.
      if (source[next + 1] !== quote) {
        return next + 1;
      }
      at = next + 2;
    }
  };
  while (index < source.length) {
    const character = source[index];
    if (source.startsWith("--", index)) {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (source.startsWith("/*", index)) {
      // Block comments nest.
      let depth = 1;
      let at = index + 2;
      while (at < source.length && depth > 0) {
        if (source.startsWith("/*", at)) {
          depth += 1;
          at += 2;
        } else if (source.startsWith("*/", at)) {
          depth -= 1;
          at += 2;
        } else {
          at += 1;
        }
      }
      index = at;
      current += " ";
      continue;
    }
    if (character === "'" || character === '"') {
      take(closingOf(character));
      continue;
    }
    if (
      character === "$" &&
      !IDENTIFIER_CHARACTER.test(source[index - 1] ?? "")
    ) {
      DOLLAR_TAG.lastIndex = index;
      const tag = DOLLAR_TAG.exec(source)?.[0];
      if (tag !== undefined) {
        // The body ends at the same tag; other tags inside it are text.
        const close = source.indexOf(tag, index + tag.length);
        take(close === -1 ? source.length : close + tag.length);
        continue;
      }
    }
    if (character === ";") {
      statements.push(current);
      current = "";
      index += 1;
      continue;
    }
    take(index + 1);
  }
  statements.push(current);
  return statements
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
};

export type ChatWritingRoutines = {
  /** Routines whose body writes a chat table, directly or through another. */
  readonly routines: ReadonlySet<string>;
  /** Tables on which a trigger runs one of them. */
  readonly triggerTables: ReadonlySet<string>;
};

type ScanOptions = {
  /** The chat tables, by bare name. */
  tables: readonly string[];
};

/** The chat-writing routines every migration in `sources` defines. */
export const chatWritingRoutinesOf = (
  sources: readonly string[],
  { tables }: ScanOptions,
): ChatWritingRoutines => {
  const statements = sources.flatMap(sqlStatementsOf);
  const bodies = new Map<string, string[]>();
  for (const statement of statements) {
    const name = ROUTINE_DEFINITION.exec(statement)?.[1];
    if (name !== undefined) {
      bodies.set(bareName(name), [
        ...(bodies.get(bareName(name)) ?? []),
        statement,
      ]);
    }
  }
  const routines = new Set<string>();
  // A routine that calls a chat-writing routine is one too; repeat until no
  // routine is added.
  for (let added = true; added;) {
    added = false;
    for (const [name, definitions] of bodies) {
      if (
        !routines.has(name) &&
        definitions.some(
          (definition) =>
            tables.some((table) => writesTable(definition, table)) ||
            [...routines].some((routine) => callsRoutine(definition, routine)),
        )
      ) {
        routines.add(name);
        added = true;
      }
    }
  }
  const triggerTables = new Set<string>();
  for (const statement of statements) {
    const trigger = TRIGGER_DEFINITION.exec(statement);
    const table = trigger?.[1];
    const routine = trigger?.[2];
    if (
      table !== undefined &&
      routine !== undefined &&
      routines.has(bareName(routine))
    ) {
      triggerTables.add(bareName(table));
    }
  }
  return { routines, triggerTables };
};

/** Whether running the migration `source` writes rows of a chat table. */
export const migrationWritesChatRows = (
  source: string,
  { tables, known }: ScanOptions & { known: ChatWritingRoutines },
): boolean =>
  sqlStatementsOf(source).some((statement) => {
    if (ROUTINE_DEFINITION.test(statement)) {
      return false;
    }
    if (
      [...tables, ...known.triggerTables].some((table) =>
        writesTable(statement, table),
      )
    ) {
      return true;
    }
    return (
      !ROUTINE_REFERENCE.test(statement) &&
      [...known.routines].some((routine) => callsRoutine(statement, routine))
    );
  });

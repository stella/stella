type SqlToken = {
  kind: "word" | "string" | "symbol";
  value: string;
  offset: number;
};

const NONPRIVATE = new Set(["admins_and_assigned", "all_members"]);

/** Preserve identifiers and literal values while excluding SQL comments. */
const tokensOf = (source: string): SqlToken[] => {
  const tokens: SqlToken[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const tail = source.slice(cursor);
    const offset = cursor;
    if (/^\s/u.test(tail)) {
      cursor += 1;
      continue;
    }
    if (tail.startsWith("--")) {
      const end = source.indexOf("\n", cursor);
      cursor = end === -1 ? source.length : end;
      continue;
    }
    if (tail.startsWith("/*")) {
      let depth = 1;
      cursor += 2;
      while (cursor < source.length && depth > 0) {
        if (source.startsWith("/*", cursor)) {
          depth += 1;
          cursor += 2;
        } else if (source.startsWith("*/", cursor)) {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      continue;
    }
    const quote = source.at(cursor);
    if (quote === "'" || quote === '"') {
      cursor += 1;
      let value = "";
      while (cursor < source.length) {
        const character = source.at(cursor);
        cursor += 1;
        if (character !== quote) {
          value += character;
        } else if (source.at(cursor) === quote) {
          value += quote;
          cursor += 1;
        } else {
          break;
        }
      }
      tokens.push({ kind: quote === "'" ? "string" : "word", value, offset });
      continue;
    }
    const word = /^(?:\$\d+|[\w]+)/u.exec(tail)?.at(0);
    if (word !== undefined) {
      tokens.push({ kind: "word", value: word.toLowerCase(), offset });
      cursor += word.length;
      continue;
    }
    tokens.push({ kind: "symbol", value: source.at(cursor) ?? "", offset });
    cursor += 1;
  }
  return tokens;
};

const rowAt = (tokens: readonly SqlToken[], start: number) => {
  if (tokens.at(start)?.value !== "(") {
    return null;
  }
  const fields: SqlToken[][] = [[]];
  let depth = 0;
  for (let cursor = start + 1; cursor < tokens.length; cursor += 1) {
    const token = tokens.at(cursor);
    if (token === undefined) {
      return null;
    }
    if (token.kind === "symbol" && token.value === ")" && depth === 0) {
      return { fields, next: cursor + 1 };
    }
    if (token.kind === "symbol" && token.value === "," && depth === 0) {
      fields.push([]);
      continue;
    }
    if (token.kind === "symbol" && token.value === "(") {
      depth += 1;
    } else if (token.kind === "symbol" && token.value === ")") {
      depth -= 1;
    }
    fields.at(-1)?.push(token);
  }
  return null;
};

const withOptionalCast = (
  field: readonly SqlToken[] | undefined,
  type: string,
): boolean =>
  field?.length === 1 ||
  (field?.length === 4 &&
    field.at(1)?.value === ":" &&
    field.at(2)?.value === ":" &&
    field.at(3)?.kind === "word" &&
    field.at(3)?.value === type);

const workspaceTarget = (
  tokens: readonly SqlToken[],
  cursor: number,
): number | null => {
  const token = tokens.at(cursor);
  if (token?.kind !== "word" || token.value !== "insert") {
    return null;
  }
  let target = cursor + 1;
  if (tokens.at(target)?.value === "into") {
    target += 1;
  }
  if (tokens.at(target)?.value === "only") {
    target += 1;
  }
  if (tokens.at(target + 1)?.value === ".") {
    target += 2;
  }
  return tokens.at(target)?.kind === "word" &&
    tokens.at(target)?.value === "workspaces"
    ? target
    : null;
};

type UnsafeRowsOptions = {
  tokens: readonly SqlToken[];
  start: number;
  visibilityIndex: number;
  idIndex: number;
  ownedIdOffsets: ReadonlySet<number>;
};
const unsafeRows = ({
  tokens,
  start,
  visibilityIndex,
  idIndex,
  ownedIdOffsets,
}: UnsafeRowsOptions): boolean => {
  let next = start;
  do {
    const row = rowAt(tokens, next);
    const value =
      visibilityIndex < 0 ? undefined : row?.fields.at(visibilityIndex);
    const id = idIndex < 0 ? undefined : row?.fields.at(idIndex);
    const owned =
      withOptionalCast(id, "uuid") &&
      ownedIdOffsets.has(id?.at(0)?.offset ?? -1);
    const nonprivate =
      withOptionalCast(value, "text") &&
      value?.at(0)?.kind === "string" &&
      NONPRIVATE.has(value.at(0)?.value ?? "");
    if (row === null || (!owned && !nonprivate)) {
      return true;
    }
    next = row.next;
    if (tokens.at(next)?.value !== ",") {
      return false;
    }
    next += 1;
  } while (next < tokens.length);
  return true;
};

/** Unknown projections and omitted visibility fail closed, including INSERT SELECT. */
export const hasUnownedWorkspaceInsert = (
  source: string,
  ownedIdOffsets: ReadonlySet<number> = new Set(),
): boolean => {
  const tokens = tokensOf(source);
  for (let cursor = 0; cursor < tokens.length; cursor += 1) {
    const target = workspaceTarget(tokens, cursor);
    if (target === null) {
      continue;
    }
    const columns = rowAt(tokens, target + 1);
    if (columns === null || tokens.at(columns.next)?.value !== "values") {
      return true;
    }
    const visibilityIndex = columns.fields.findIndex(
      (field) => field.length === 1 && field.at(0)?.value === "visibility",
    );
    const idIndex = columns.fields.findIndex(
      (field) => field.length === 1 && field.at(0)?.value === "id",
    );
    if (
      unsafeRows({
        tokens,
        start: columns.next + 1,
        visibilityIndex,
        idIndex,
        ownedIdOffsets,
      })
    ) {
      return true;
    }
  }
  return false;
};

export const isPreVisibilityWorkspaceInsert = (source: string): boolean => {
  const tokens = tokensOf(source);
  return !tokens.some((token) =>
    ["visibility", "assigned_only"].includes(token.value.toLowerCase()),
  );
};

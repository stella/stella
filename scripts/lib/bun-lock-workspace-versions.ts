type JsonNode =
  | { kind: "object"; properties: Map<string, JsonNode> }
  | { kind: "string"; start: number; end: number; value: string }
  | { kind: "other" };

export type WorkspaceVersionMismatch = {
  workspace: string;
  expected: string;
  actual: string | null;
};

export type WorkspaceVersionSyncResult = {
  text: string;
  mismatches: WorkspaceVersionMismatch[];
};

/**
 * Synchronize only workspace self-version string values in a Bun lockfile.
 *
 * Bun does not refresh these cached values when package.json versions change.
 * This parser finds their exact JSON string spans and changes nothing else, so
 * a version-up/version-down round trip restores the original bytes.
 */
export const syncWorkspaceVersions = (
  source: string,
  expectedVersions: ReadonlyMap<string, string>,
): WorkspaceVersionSyncResult => {
  let cursor = 0;

  const fail = (message: string): never => {
    throw new Error(`Invalid bun.lock at byte ${cursor}: ${message}`);
  };

  const skipTrivia = (): void => {
    while (cursor < source.length) {
      if (/\s/.test(source[cursor] ?? "")) {
        cursor += 1;
        continue;
      }
      if (source.startsWith("//", cursor)) {
        const newline = source.indexOf("\n", cursor + 2);
        cursor = newline === -1 ? source.length : newline + 1;
        continue;
      }
      if (source.startsWith("/*", cursor)) {
        const end = source.indexOf("*/", cursor + 2);
        if (end === -1) fail("unterminated block comment");
        cursor = end + 2;
        continue;
      }
      break;
    }
  };

  const parseString = (): Extract<JsonNode, { kind: "string" }> => {
    skipTrivia();
    const start = cursor;
    if (source[cursor] !== '"') fail("expected a string");
    cursor += 1;
    while (cursor < source.length) {
      const character = source[cursor];
      if (character === "\\") {
        cursor += 2;
        continue;
      }
      cursor += 1;
      if (character === '"') {
        const raw = source.slice(start, cursor);
        return {
          kind: "string",
          start,
          end: cursor,
          value: JSON.parse(raw) as string,
        };
      }
    }
    return fail("unterminated string");
  };

  const parseValue = (): JsonNode => {
    skipTrivia();
    if (source[cursor] === '"') return parseString();
    if (source[cursor] === "{") return parseObject();
    if (source[cursor] === "[") {
      cursor += 1;
      skipTrivia();
      while (source[cursor] !== "]") {
        parseValue();
        skipTrivia();
        if (source[cursor] === ",") {
          cursor += 1;
          skipTrivia();
          if (source[cursor] === "]") break;
        } else if (source[cursor] !== "]") {
          fail("expected ',' or ']' in array");
        }
      }
      if (source[cursor] !== "]") fail("unterminated array");
      cursor += 1;
      return { kind: "other" };
    }

    const start = cursor;
    while (cursor < source.length && !/[\s,}\]]/.test(source[cursor] ?? "")) {
      cursor += 1;
    }
    if (cursor === start) fail("expected a value");
    return { kind: "other" };
  };

  const parseObject = (): Extract<JsonNode, { kind: "object" }> => {
    skipTrivia();
    if (source[cursor] !== "{") fail("expected an object");
    cursor += 1;
    const properties = new Map<string, JsonNode>();
    skipTrivia();
    while (source[cursor] !== "}") {
      const key = parseString().value;
      skipTrivia();
      if (source[cursor] !== ":") fail("expected ':' after object key");
      cursor += 1;
      properties.set(key, parseValue());
      skipTrivia();
      if (source[cursor] === ",") {
        cursor += 1;
        skipTrivia();
        if (source[cursor] === "}") break;
      } else if (source[cursor] !== "}") {
        fail("expected ',' or '}' in object");
      }
    }
    if (source[cursor] !== "}") fail("unterminated object");
    cursor += 1;
    return { kind: "object", properties };
  };

  const root = parseValue();
  skipTrivia();
  if (cursor !== source.length) fail("unexpected content after root value");
  if (root.kind !== "object") {
    throw new Error("Invalid bun.lock: root must be an object");
  }
  const workspaces = root.properties.get("workspaces");
  if (workspaces?.kind !== "object") {
    throw new Error(
      "Invalid bun.lock: root workspaces property must be an object",
    );
  }

  const mismatches: WorkspaceVersionMismatch[] = [];
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const [workspace, expected] of expectedVersions) {
    const entry = workspaces.properties.get(workspace);
    const version =
      entry?.kind === "object" ? entry.properties.get("version") : undefined;
    const actual = version?.kind === "string" ? version.value : null;
    if (actual === expected) continue;
    mismatches.push({ workspace, expected, actual });
    if (version?.kind === "string") {
      replacements.push({
        start: version.start,
        end: version.end,
        value: JSON.stringify(expected),
      });
    }
  }

  let text = source;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    text =
      text.slice(0, replacement.start) +
      replacement.value +
      text.slice(replacement.end);
  }
  return { text, mismatches };
};

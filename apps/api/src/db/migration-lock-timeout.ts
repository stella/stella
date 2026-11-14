/**
 * Apply the runner's queue bound to top-level timeout settings without changing
 * stored migration hashes. Zero remains reserved for concurrent index sections;
 * quoted routine bodies retain their own explicitly bounded timeout policies.
 * Appending the runner setting keeps comments and original statements intact.
 */
export const withMigrationLockTimeout = (
  source: string,
  lockTimeoutMs: number,
) => {
  const statements: string[] = [];
  let start = 0;
  let index = 0;
  let visible = "";
  let blockDepth = 0;
  let lineComment = false;
  let quote: "'" | '"' | undefined;
  let escape = false;
  let dollar: string | undefined;
  const append = (end: number) => {
    const normalized = visible
      .trim()
      .replace(/;$/u, "")
      .replace("=", " = ")
      .trimEnd();
    const words = normalized.split(/\s+/u);
    const offset = ["LOCAL", "SESSION"].includes(
      words.at(1)?.toUpperCase() ?? "",
    )
      ? 1
      : 0;
    const value =
      words.length === 4 + offset &&
      words.at(0)?.toUpperCase() === "SET" &&
      words.at(1 + offset)?.toLowerCase() === "lock_timeout" &&
      ["=", "TO"].includes(words.at(2 + offset)?.toUpperCase() ?? "")
        ? words.at(3 + offset)
        : undefined;
    const original = source.slice(start, end);
    statements.push(
      value !== undefined && !/^'?0\s*(?:us|ms|s|min|h|d)?'?$/iu.test(value)
        ? `${original}${visible.trimEnd().endsWith(";") ? "" : "\n;"}\nSET${/^\s*SET\s+LOCAL\b/iu.test(visible) ? " LOCAL" : ""} lock_timeout = '${String(lockTimeoutMs)}ms';`
        : original,
    );
    start = end;
    visible = "";
  };
  while (index < source.length) {
    const char = source.charAt(index);
    const next = source.charAt(index + 1);
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        visible += "\n";
      }
      index += 1;
      continue;
    }
    if (blockDepth > 0) {
      if (char === "/" && next === "*") {
        blockDepth += 1;
        index += 2;
      } else if (char === "*" && next === "/") {
        blockDepth -= 1;
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (dollar !== undefined) {
      if (source.startsWith(dollar, index)) {
        index += dollar.length;
        dollar = undefined;
      } else {
        index += 1;
      }
      continue;
    }
    if (quote !== undefined) {
      visible += char;
      if ((escape && char === "\\") || (char === quote && next === quote)) {
        visible += next;
        index += 2;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      index += 1;
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      visible += " ";
      index += 2;
      continue;
    }
    if (char === "/" && next === "*") {
      blockDepth = 1;
      visible += " ";
      index += 2;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      escape = char === "'" && /(?:^|[^\w$])[eE]$/u.test(visible);
    } else if (
      char === "$" &&
      (index === 0 || !/[\w$]/u.test(source.charAt(index - 1)))
    ) {
      const delimiter = /^\$(?:[A-Za-z_][\w]*\$|\$)/u
        .exec(source.slice(index))
        ?.at(0);
      if (delimiter !== undefined) {
        dollar = delimiter;
        visible += " BODY ";
        index += delimiter.length;
        continue;
      }
    }
    visible += char;
    index += 1;
    if (char === ";") {
      append(index);
    }
  }
  append(source.length);
  return statements.join("");
};

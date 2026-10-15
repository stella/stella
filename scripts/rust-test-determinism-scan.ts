/**
 * Lexical Rust test census: comments and literals are masked before scanning.
 * This does not expand macros, resolve imports/aliases or shadowed static names,
 * or evaluate arbitrary cfg expressions. Test items use cfg(test), test, or
 * tokio::test attributes; a leading inner cfg(test) covers the entire file.
 * External test modules are selected by the caller.
 * External modules with #[path] and statics declared in other files are not
 * resolved. Identifier touches count even when a local shadows a static.
 */

export type RustTestDeterminismHit = {
  line: number;
  kind: "sleep" | "clock" | "process" | "global-lock";
  escaped: boolean;
};

type Span = { start: number; end: number };

const quotedEnd = (source: string, start: number): number => {
  let cursor = start + 1;
  while (cursor < source.length) {
    if (source[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (source[cursor] === '"') {
      return cursor + 1;
    }
    cursor += 1;
  }
  return source.length;
};

const blockCommentEnd = (source: string, start: number): number => {
  let depth = 1;
  let cursor = start + 2;
  while (cursor < source.length && depth > 0) {
    const pair = source.slice(cursor, cursor + 2);
    if (pair === "/*") {
      depth += 1;
      cursor += 2;
    } else if (pair === "*/") {
      depth -= 1;
      cursor += 2;
    } else {
      cursor += 1;
    }
  }
  return cursor;
};

const literalEnd = (source: string, start: number): number | undefined => {
  const char = source[start];
  if (char === '"') {
    return quotedEnd(source, start);
  }
  if (char === "'") {
    const character =
      /^'(?:\\(?:u\{[\da-fA-F_]+\}|x[\da-fA-F]{2}|[^\r\n])|[^'\\\r\n])'/u.exec(
        source.slice(start),
      );
    return character ? start + character[0].length : undefined;
  }
  if (char !== "r" && char !== "b" && char !== "c") {
    return undefined;
  }
  const raw = /^(?:br|cr|r)#*"/u.exec(source.slice(start));
  if (!raw) {
    return undefined;
  }
  const delimiter = `"${raw[0].slice(raw[0].indexOf("r") + 1, -1)}`;
  const end = source.indexOf(delimiter, start + raw[0].length);
  return end === -1 ? source.length : end + delimiter.length;
};

const maskRust = (source: string) => {
  const characters = source.split("");
  const escapedLines = new Set<number>();
  let line = 1;
  let cursor = 0;
  while (cursor < source.length) {
    const pair = source.slice(cursor, cursor + 2);
    let end: number | undefined;
    if (pair === "//") {
      const newline = source.indexOf("\n", cursor);
      end = newline === -1 ? source.length : newline;
      if (/^\/\/\s*kit-allow:\s*\S/u.test(source.slice(cursor, end))) {
        escapedLines.add(line);
      }
    } else if (pair === "/*") {
      end = blockCommentEnd(source, cursor);
    } else {
      end = literalEnd(source, cursor);
    }
    if (end === undefined) {
      if (source[cursor] === "\n") {
        line += 1;
      }
      cursor += 1;
      continue;
    }
    while (cursor < end) {
      if (source[cursor] === "\n") {
        line += 1;
      } else if (source[cursor] !== "\r") {
        characters[cursor] = " ";
      }
      cursor += 1;
    }
  }
  return { code: characters.join(""), escapedLines };
};

const closingBraces = (code: string): Map<number, number> => {
  const stack: number[] = [];
  const pairs = new Map<number, number>();
  for (let cursor = 0; cursor < code.length; cursor += 1) {
    if (code[cursor] === "{") {
      stack.push(cursor);
    } else if (code[cursor] === "}") {
      const open = stack.pop();
      if (open !== undefined) {
        pairs.set(open, cursor);
      }
    }
  }
  return pairs;
};

const hasFileTestAttribute = (code: string): boolean => {
  let cursor = 0;
  while (cursor < code.length) {
    const opening = /^\s*#\s*!\s*\[/u.exec(code.slice(cursor));
    if (opening === null) {
      return false;
    }
    const start = cursor + opening[0].length;
    cursor = start;
    let depth = 1;
    while (cursor < code.length && depth > 0) {
      if (code[cursor] === "[") {
        depth += 1;
      } else if (code[cursor] === "]") {
        depth -= 1;
      }
      cursor += 1;
    }
    if (depth !== 0) {
      return false;
    }
    if (/^\s*cfg\s*\(\s*test\s*\)\s*$/u.test(code.slice(start, cursor - 1))) {
      return true;
    }
  }
  return false;
};

const itemBodyStart = (code: string, start: number): number | undefined => {
  const closing: string[] = [];
  for (let cursor = start; cursor < code.length; cursor += 1) {
    const token = code.charAt(cursor);
    if (
      closing.length === 0 &&
      (token === "{" || token === ";" || token === "}")
    ) {
      return token === "{" ? cursor : undefined;
    }
    switch (token) {
      case "(":
        closing.push(")");
        break;
      case "[":
        closing.push("]");
        break;
      case "<":
        // Braced const expressions may contain comparison operators.
        if (!closing.includes("}")) {
          closing.push(">");
        }
        break;
      case "{":
        closing.push("}");
        break;
      default:
        // Return arrows do not close generic arguments containing function types.
        if (
          token === closing.at(-1) &&
          !(token === ">" && code[cursor - 1] === "-")
        ) {
          closing.pop();
        }
    }
  }
  return undefined;
};

const testSpans = (code: string, integrationTest: boolean): Span[] => {
  if (integrationTest || hasFileTestAttribute(code)) {
    return [{ start: 0, end: code.length }];
  }
  const braces = closingBraces(code);
  const spans: Span[] = [];
  const attribute =
    /#\s*\[\s*(?:cfg\s*\(\s*test\s*\)|(?:tokio\s*::\s*)?test(?:\s*\([^\]]*\))?)\s*\]/gu;
  for (const match of code.matchAll(attribute)) {
    const after = match.index + match[0].length;
    const open = itemBodyStart(code, after);
    if (open === undefined) {
      continue;
    }
    if (
      !/\b(?:(?:fn|mod)\s+[A-Za-z_]\w*|impl\b)/u.test(code.slice(after, open))
    ) {
      continue;
    }
    const close = braces.get(open);
    if (close !== undefined) {
      spans.push({ start: open + 1, end: close });
    }
  }
  return spans;
};

const inlineModuleSpans = (code: string) => {
  const braces = closingBraces(code);
  const modules: (Span & { name: string })[] = [];
  for (const match of code.matchAll(/\bmod\s+([A-Za-z_]\w*)\s*\{/gu)) {
    const name = match[1];
    const open = match.index + match[0].length - 1;
    const close = braces.get(open);
    if (name !== undefined && close !== undefined) {
      modules.push({ name, start: open + 1, end: close });
    }
  }
  return modules;
};

export const findRustExternalModules = (source: string) => {
  const { code } = maskRust(source);
  const spans = testSpans(code, false);
  const inlineModules = inlineModuleSpans(code);
  const modules: { name: string; test: boolean }[] = [];
  const external =
    /((?:#\s*\[[^\]]*\]\s*)*)(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/gu;
  for (const match of code.matchAll(external)) {
    const name = match[2];
    if (name === undefined) {
      continue;
    }
    const test =
      /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/u.test(match[1] ?? "") ||
      spans.some(({ start, end }) => match.index >= start && match.index < end);
    const parents = inlineModules
      .filter(({ start, end }) => match.index >= start && match.index < end)
      .map((parent) => parent.name);
    modules.push({ name: [...parents, name].join("/"), test });
  }
  return modules;
};

const globalStatics = (code: string) => {
  const names = new Set<string>();
  const declarations: Span[] = [];
  const declaration =
    /\bstatic\s+(?:mut\s+)?([A-Za-z_]\w*)\s*:\s*([^\s=;][^=;]*)[=;]/gu;
  for (const match of code.matchAll(declaration)) {
    if (!/\b(?:Mutex|RwLock|OnceLock)\b/u.test(match[2] ?? "")) {
      continue;
    }
    const name = match[1];
    if (name === undefined) {
      continue;
    }
    names.add(name);
    const end = code.indexOf(";", match.index + match[0].length - 1);
    declarations.push({
      start: match.index,
      end: end === -1 ? code.length : end + 1,
    });
  }
  return { names, declarations };
};

type Occurrence = { start: number; kind: RustTestDeterminismHit["kind"] };

const occurrences = (code: string): Occurrence[] => {
  const found: Occurrence[] = [];
  const patterns = [
    {
      kind: "sleep",
      pattern:
        /\b(?:(?:std\s*::\s*)?thread\s*::\s*sleep|tokio\s*::\s*time\s*::\s*sleep)\s*\(/gu,
    },
    { kind: "clock", pattern: /\b(?:Instant|SystemTime)\s*::\s*now\s*\(/gu },
    { kind: "process", pattern: /\bCommand\s*::\s*new\s*\(/gu },
  ] as const;
  for (const { kind, pattern } of patterns) {
    for (const match of code.matchAll(pattern)) {
      found.push({ start: match.index, kind });
    }
  }
  const { names, declarations } = globalStatics(code);
  for (const match of code.matchAll(/\b[A-Za-z_]\w*\b/gu)) {
    if (
      names.has(match[0]) &&
      !declarations.some(
        ({ start, end }) => match.index >= start && match.index < end,
      )
    ) {
      found.push({ start: match.index, kind: "global-lock" });
    }
  }
  return found.toSorted((left, right) => left.start - right.start);
};

type ScanRustTestDeterminismOptions = {
  source: string;
  integrationTest: boolean;
};

export const scanRustTestDeterminism = ({
  source,
  integrationTest,
}: ScanRustTestDeterminismOptions): RustTestDeterminismHit[] => {
  const { code, escapedLines } = maskRust(source);
  const spans = testSpans(code, integrationTest);
  const hits: RustTestDeterminismHit[] = [];
  let line = 1;
  let cursor = 0;
  for (const { start, kind } of occurrences(code)) {
    if (!spans.some((span) => start >= span.start && start < span.end)) {
      continue;
    }
    while (cursor < start) {
      if (code[cursor] === "\n") {
        line += 1;
      }
      cursor += 1;
    }
    hits.push({
      line,
      kind,
      escaped: escapedLines.has(line) || escapedLines.has(line - 1),
    });
  }
  return hits;
};

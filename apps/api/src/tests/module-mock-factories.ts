import { panic } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { resolveModuleSpecifier } from "./module-mock-batching";

// Every call site this reader must account for: a `mock.module` naming its
// target with a string literal. A computed target names no module to compare
// against and is out of scope for both this pattern and the reader.
//
// Written with an escaped dot so this module's own source does not read as a
// `mock.module` call site to the runner's helper scan (scripts/run-tests.ts).
const MODULE_MOCK_CALL_PATTERN = /\bmock\.module\s*\(\s*["']([^"']+)["']\s*,/gu;
// The `() => (` an object-literal factory opens with, measured from just past
// the target literal's comma.
const OBJECT_FACTORY_PREFIX_PATTERN = /^\s*(?:async\s+)?\(\s*\)\s*=>\s*\(\s*/u;
const STAR_REEXPORT_PATTERN = /\bexport\s*\*\s*from\s*["']([^"']+)["']/gu;
const OBJECT_KEY_PATTERN =
  /^(?:(?:get|set)\s+)?(?:([A-Za-z_$][\w$]*)|"([^"]+)"|'([^']+)')$/u;
const MODULE_FILE_SUFFIXES = [
  ".ts",
  ".tsx",
  "/index.ts",
  "/index.tsx",
] as const;

const transpilers = new Map<string, Bun.Transpiler>();
const transpilerFor = (modulePath: string): Bun.Transpiler => {
  const loader = modulePath.endsWith("x") ? "tsx" : "ts";
  const cached = transpilers.get(loader);
  if (cached !== undefined) {
    return cached;
  }
  const transpiler = new Bun.Transpiler({ loader });
  transpilers.set(loader, transpiler);
  return transpiler;
};

export type ModuleMockFactory = {
  /** Keys the factory declares, spreads excluded. */
  declaredKeys: string[];
  /** Api-relative path of the file holding the `mock.module` call. */
  filePath: string;
  line: number;
  /** Canonicalized mock target, e.g. `src/lib/analytics/capture`. */
  moduleId: string;
  /** Mock target exactly as written, e.g. `@/api/lib/analytics/capture`. */
  specifier: string;
  /** True when the factory spreads another object (`...realCapture`). */
  spreadsAnother: boolean;
};

/**
 * The text between the braces of the object literal starting at `openIndex`,
 * respecting nesting, strings, and comments.
 */
const readObjectLiteral = (
  source: string,
  openIndex: number,
): string | undefined => {
  let depth = 0;
  let index = openIndex;
  while (index < source.length) {
    const char = source[index];
    if (char === undefined) {
      return undefined;
    }
    if (char === '"' || char === "'" || char === "`") {
      index = skipString(source, index);
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index);
      if (index === -1) {
        return undefined;
      }
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) {
        return undefined;
      }
      index = end + 2;
      continue;
    }
    if (char === "{" || char === "[" || char === "(") {
      depth += 1;
    } else if (char === "}" || char === "]" || char === ")") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openIndex + 1, index);
      }
    }
    index += 1;
  }
  return undefined;
};

const skipString = (source: string, openIndex: number): number => {
  const quote = source[openIndex];
  let index = openIndex + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) {
      return index + 1;
    }
    index += 1;
  }
  return source.length;
};

/** Split an object-literal body on its top-level commas. */
const splitTopLevelEntries = (body: string): string[] => {
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  let index = 0;
  while (index < body.length) {
    const char = body[index];
    if (char === undefined) {
      break;
    }
    if (char === '"' || char === "'" || char === "`") {
      index = skipString(body, index);
      continue;
    }
    if (char === "/" && body[index + 1] === "/") {
      const lineEnd = body.indexOf("\n", index);
      index = lineEnd === -1 ? body.length : lineEnd;
      continue;
    }
    if (char === "/" && body[index + 1] === "*") {
      const end = body.indexOf("*/", index + 2);
      index = end === -1 ? body.length : end + 2;
      continue;
    }
    if (char === "{" || char === "[" || char === "(") {
      depth += 1;
    } else if (char === "}" || char === "]" || char === ")") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      entries.push(body.slice(start, index));
      start = index + 1;
    }
    index += 1;
  }
  entries.push(body.slice(start));
  return entries.map((entry) => entry.trim()).filter((entry) => entry !== "");
};

const readEntryKey = (entry: string): string | undefined => {
  const separator = entry.search(/[:(]/u);
  const head = (separator === -1 ? entry : entry.slice(0, separator)).trim();
  const match = OBJECT_KEY_PATTERN.exec(head);
  return match?.at(1) ?? match?.at(2) ?? match?.at(3);
};

type FactoryKeys = Pick<ModuleMockFactory, "declaredKeys" | "spreadsAnother">;

/**
 * A factory this reader cannot judge: a block body, a returned variable, a
 * computed key. Reported with no declared keys and marked as spreading so the
 * drift guards skip it rather than comparing keys that may be mis-parsed.
 */
const opaqueFactory = (): FactoryKeys => ({
  declaredKeys: [],
  spreadsAnother: true,
});

/** Keys of the object literal a factory returns, read from `bodyStart` (just
 *  past the target literal's comma). */
const readFactoryKeys = (
  source: string,
  bodyStart: number,
  filePath: string,
): FactoryKeys => {
  const prefix = OBJECT_FACTORY_PREFIX_PATTERN.exec(source.slice(bodyStart));
  if (prefix === null) {
    return opaqueFactory();
  }
  const openIndex = bodyStart + prefix[0].length;
  if (source[openIndex] !== "{") {
    return opaqueFactory();
  }
  const literalBody = readObjectLiteral(source, openIndex);
  if (literalBody === undefined) {
    panic(`unterminated mock factory in ${filePath}`);
  }
  const declaredKeys: string[] = [];
  let spreadsAnother = false;
  for (const entry of splitTopLevelEntries(literalBody)) {
    if (entry.startsWith("...")) {
      spreadsAnother = true;
      continue;
    }
    const key = readEntryKey(entry);
    if (key === undefined) {
      return opaqueFactory();
    }
    declaredKeys.push(key);
  }
  return { declaredKeys, spreadsAnother };
};

/**
 * Every module-mock call in `source` that names a literal specifier, one entry
 * per call site. A factory whose keys cannot be read is reported as opaque
 * rather than skipped, so a body shape this reader stops recognizing cannot
 * quietly narrow the guards built on it to the mocks that still parse.
 */
export const readModuleMockFactories = (
  source: string,
  filePath: string,
): ModuleMockFactory[] => {
  const factories: ModuleMockFactory[] = [];
  for (const match of source.matchAll(MODULE_MOCK_CALL_PATTERN)) {
    const specifier = match.at(1);
    const matchIndex = match.index;
    if (specifier === undefined) {
      continue;
    }
    factories.push({
      ...readFactoryKeys(source, matchIndex + match[0].length, filePath),
      filePath,
      line: source.slice(0, matchIndex).split("\n").length,
      moduleId: resolveModuleSpecifier(specifier, filePath),
      specifier,
    });
  }
  return factories;
};

/**
 * Call sites `readModuleMockFactories` is expected to return an entry for.
 * Counted separately so the two can be compared per file, in both directions.
 */
export const countModuleMockCallSites = (source: string): number =>
  [...source.matchAll(MODULE_MOCK_CALL_PATTERN)].length;

/**
 * Resolve a canonicalized api-relative module id to a file on disk, or
 * `undefined` for a specifier that does not live in this package (an npm or
 * workspace package, whose exports are not statically readable here).
 */
export const resolveModuleFile = (
  moduleId: string,
  apiRoot: string,
): string | undefined => {
  if (!moduleId.startsWith("src/")) {
    return undefined;
  }
  for (const suffix of MODULE_FILE_SUFFIXES) {
    const candidate = path.join(apiRoot, `${moduleId}${suffix}`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
};

/**
 * Names a module exports at runtime, read from its SOURCE rather than by
 * importing it: importing a module inside the suite would run its side effects
 * and, worse, register it in the same process the mocks live in. `export *`
 * re-exports are followed so a facade module reports the names it forwards.
 */
export const readModuleExports = (
  moduleFile: string,
  apiRoot: string,
  seen = new Set<string>(),
): Set<string> => {
  const exports = new Set<string>();
  if (seen.has(moduleFile)) {
    return exports;
  }
  seen.add(moduleFile);

  const source = readFileSync(moduleFile, "utf-8");
  for (const name of transpilerFor(moduleFile).scan(source).exports) {
    exports.add(name);
  }

  const apiRelative = path.relative(apiRoot, moduleFile);
  for (const match of source.matchAll(STAR_REEXPORT_PATTERN)) {
    const specifier = match.at(1);
    if (specifier === undefined) {
      continue;
    }
    const reexportFile = resolveModuleFile(
      resolveModuleSpecifier(specifier, apiRelative),
      apiRoot,
    );
    if (reexportFile === undefined) {
      continue;
    }
    for (const name of readModuleExports(reexportFile, apiRoot, seen)) {
      exports.add(name);
    }
  }

  return exports;
};

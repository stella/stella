// Two ledgers that keep surfaces rendering through `@stll/ui` from drifting
// away from it one call site at a time. Both are read from the files
// `no-native-ui` lints (DESIGN_SYSTEM_CONSUMER_FILES, tests and fixtures
// excluded), and both are design decisions reviewed by the design-system
// owners (.github/CODEOWNERS):
//
//   .oxlint-plugins/no-native-ui-exceptions.json
//       every `oxlint-disable…` directive that silences a `no-native-ui/*`
//       rule: its file, the rule, and the reason written after `--`.
//       `.oxlint-plugins/__tests__/no-native-ui-exceptions.test.ts` fails
//       when a directive is missing from it, an entry no longer matches a
//       directive, or a reason changed.
//
//   .oxlint-plugins/ui-usage-ledger.json
//       per file, how many `Button variant="plain"` it renders and how many
//       raw `<kbd>` elements. `.oxlint-plugins/__tests__/ui-usage-ledger.test.ts`
//       fails on any difference, up or down, so a new plain button or key cap
//       is added on purpose and a removed one gives its allowance back.
//
// Usage:
//   bun scripts/ui-drift-ledgers.ts           print the differences
//   bun scripts/ui-drift-ledgers.ts --write   rewrite both ledgers from the tree

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";

import { DESIGN_SYSTEM_CONSUMER_FILES } from "./product-frontend-files.ts";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..");

export const NO_NATIVE_UI_EXCEPTIONS_PATH =
  ".oxlint-plugins/no-native-ui-exceptions.json";
export const UI_USAGE_LEDGER_PATH = ".oxlint-plugins/ui-usage-ledger.json";
export const UI_DRIFT_WRITE = "bun scripts/ui-drift-ledgers.ts --write";

const EXCLUDED =
  /(?:^|\/)(?:__tests__|__fixtures__|node_modules)\/|\.(?:test|spec)\.tsx?$/u;

/** Repository-relative POSIX paths of the files `no-native-ui` lints. */
const consumerSourceFiles = (): string[] => {
  const files = new Set<string>();
  for (const pattern of DESIGN_SYSTEM_CONSUMER_FILES) {
    for (const file of new Bun.Glob(pattern).scanSync(REPOSITORY_ROOT)) {
      const posix = file.split(path.sep).join("/");
      if (!EXCLUDED.test(posix)) {
        files.add(posix);
      }
    }
  }
  return [...files].toSorted(compareCodeUnit);
};

// --- no-native-ui exceptions ------------------------------------------------

type NoNativeUiException = {
  readonly file: string;
  readonly rule: string;
  readonly reason: string;
};

const ExceptionsSchema = v.array(
  v.object({ file: v.string(), rule: v.string(), reason: v.string() }),
);

/**
 * A disable directive in a line or block comment, in either spelling oxlint
 * honours: the rule list, then an optional `-- reason`.
 */
const DIRECTIVE =
  /(?:\/\/|\/\*)\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?\s+(?<body>.*)$/u;

const NO_NATIVE_UI_RULE = /^no-native-ui\/[a-z0-9-]+$/u;

/** The `no-native-ui/*` exceptions one source declares. */
export const exceptionsIn = (
  file: string,
  source: string,
): NoNativeUiException[] =>
  source.split("\n").flatMap((line) => {
    const body = DIRECTIVE.exec(line)?.groups?.["body"];
    if (body === undefined) {
      return [];
    }
    const text = body.replace(/\s*\*\/\s*\}?\s*$/u, "");
    const separator = text.search(/\s--(?:\s|$)/u);
    const rules = (separator === -1 ? text : text.slice(0, separator))
      .split(",")
      .map((rule) => rule.trim());
    const reason =
      separator === -1
        ? ""
        : text.slice(separator).replace(/^\s--/u, "").trim();
    return rules
      .filter((rule) => NO_NATIVE_UI_RULE.test(rule))
      .map((rule) => ({ file, rule, reason }));
  });

const exceptionKey = ({ file, rule, reason }: NoNativeUiException): string =>
  JSON.stringify([file, rule, reason]);

const compareExceptions = (
  left: NoNativeUiException,
  right: NoNativeUiException,
): number => compareCodeUnit(exceptionKey(left), exceptionKey(right));

export const readNoNativeUiExceptions = (
  files: readonly string[] = consumerSourceFiles(),
): NoNativeUiException[] =>
  files
    .flatMap((file) => {
      const source = readFileSync(path.join(REPOSITORY_ROOT, file), "utf-8");
      return source.includes("no-native-ui/") ? exceptionsIn(file, source) : [];
    })
    .toSorted(compareExceptions);

export const readCommittedNoNativeUiExceptions = (): NoNativeUiException[] =>
  v.parse(
    ExceptionsSchema,
    JSON.parse(
      readFileSync(
        path.join(REPOSITORY_ROOT, NO_NATIVE_UI_EXCEPTIONS_PATH),
        "utf-8",
      ),
    ),
  );

/** Entries of `left` that `right` does not hold, counting duplicates. */
const multisetDifference = (
  left: readonly NoNativeUiException[],
  right: readonly NoNativeUiException[],
): NoNativeUiException[] => {
  const remaining = new Map<string, number>();
  for (const entry of right) {
    const key = exceptionKey(entry);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  return left.filter((entry) => {
    const key = exceptionKey(entry);
    const count = remaining.get(key) ?? 0;
    remaining.set(key, count - 1);
    return count <= 0;
  });
};

/**
 * Where the ledger and the tree disagree, one line each: a directive with no
 * entry (or a changed reason), an entry with no directive, a directive with
 * no reason.
 */
export const exceptionMismatches = (
  committed: readonly NoNativeUiException[],
  current: readonly NoNativeUiException[],
): string[] => {
  const unlisted = multisetDifference(current, committed);
  const stale = multisetDifference(committed, current);
  const errors = current
    .filter(({ reason }) => reason.length === 0)
    .map(
      ({ file, rule }) =>
        `${file}: the ${rule} directive gives no reason; write it after \` -- \``,
    );
  for (const entry of unlisted) {
    const previous = stale.find(
      ({ file, rule }) => file === entry.file && rule === entry.rule,
    );
    errors.push(
      previous === undefined
        ? `${entry.file}: new ${entry.rule} exception, not in the ledger: ${JSON.stringify(entry)}`
        : `${entry.file}: the ${entry.rule} reason changed from ${JSON.stringify(previous.reason)} to ${JSON.stringify(entry.reason)}`,
    );
  }
  for (const entry of stale) {
    if (
      !unlisted.some(
        ({ file, rule }) => file === entry.file && rule === entry.rule,
      )
    ) {
      errors.push(
        `${entry.file}: the ledger lists a ${entry.rule} exception the file no longer has: ${JSON.stringify(entry)}`,
      );
    }
  }
  return errors;
};

// --- usage ledger -----------------------------------------------------------

/** What the usage ledger counts, and how one occurrence reads in source. */
const UI_USAGE_PATTERNS = {
  // `variant="plain"`, `variant={"plain"}` and a ternary with a plain branch
  // (not one that only compares against "plain").
  "plain-button":
    /\bvariant=(?:["']plain["']|\{\s*["'`]plain["'`]\s*\}|\{[^{}]*[?:]\s*["'`]plain["'`][^{}]*\})/gu,
  // A raw key cap; `@stll/ui/kbd` draws keys for the reader's platform.
  "raw-kbd": /<kbd\b/gu,
} as const satisfies Record<string, RegExp>;

type UiUsageKind = keyof typeof UI_USAGE_PATTERNS;
type UiUsageLedger = Record<UiUsageKind, Record<string, number>>;

const UI_USAGE_KINDS: readonly UiUsageKind[] = ["plain-button", "raw-kbd"];

const UsageLedgerSchema = v.object({
  "plain-button": v.record(v.string(), v.number()),
  "raw-kbd": v.record(v.string(), v.number()),
});

export const usageCount = (kind: UiUsageKind, source: string): number =>
  [...source.matchAll(UI_USAGE_PATTERNS[kind])].length;

export const readUiUsage = (
  files: readonly string[] = consumerSourceFiles(),
): UiUsageLedger => {
  const counts = new Map<UiUsageKind, [string, number][]>(
    UI_USAGE_KINDS.map((kind) => [kind, []]),
  );
  for (const file of files) {
    const source = readFileSync(path.join(REPOSITORY_ROOT, file), "utf-8");
    for (const kind of UI_USAGE_KINDS) {
      const count = usageCount(kind, source);
      if (count > 0) {
        counts.get(kind)?.push([file, count]);
      }
    }
  }
  return {
    "plain-button": Object.fromEntries(counts.get("plain-button") ?? []),
    "raw-kbd": Object.fromEntries(counts.get("raw-kbd") ?? []),
  };
};

export const readCommittedUiUsage = (): UiUsageLedger =>
  v.parse(
    UsageLedgerSchema,
    JSON.parse(
      readFileSync(path.join(REPOSITORY_ROOT, UI_USAGE_LEDGER_PATH), "utf-8"),
    ),
  );

/** One line per file whose count differs from the ledger. */
export const usageMismatches = (
  committed: UiUsageLedger,
  current: UiUsageLedger,
): string[] =>
  UI_USAGE_KINDS.flatMap((kind) => {
    const files = [
      ...new Set([
        ...Object.keys(committed[kind]),
        ...Object.keys(current[kind]),
      ]),
    ].toSorted(compareCodeUnit);
    return files.flatMap((file) => {
      const before = committed[kind][file] ?? 0;
      const after = current[kind][file] ?? 0;
      if (before === after) {
        return [];
      }
      return [
        `${kind} ${file}: ${after} in the file, ${before} in the ledger (${after > before ? "added" : "removed"})`,
      ];
    });
  });

const usageTotal = (ledger: UiUsageLedger, kind: UiUsageKind): number => {
  let total = 0;
  for (const count of Object.values(ledger[kind])) {
    total += count;
  }
  return total;
};

// --- write ------------------------------------------------------------------

const writeJson = (file: string, value: unknown): void => {
  const absolute = path.join(REPOSITORY_ROOT, file);
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
  // The ledgers are committed in the formatter's layout, so a rewrite leaves
  // no formatting diff behind.
  Bun.spawnSync([process.execPath, "fmt", absolute], { cwd: REPOSITORY_ROOT });
};

if (import.meta.main) {
  const files = consumerSourceFiles();
  const exceptions = readNoNativeUiExceptions(files);
  const usage = readUiUsage(files);
  if (process.argv.includes("--write")) {
    writeJson(NO_NATIVE_UI_EXCEPTIONS_PATH, exceptions);
    writeJson(UI_USAGE_LEDGER_PATH, usage);
    console.log(
      `Wrote ${NO_NATIVE_UI_EXCEPTIONS_PATH} (${exceptions.length} exceptions) and ` +
        `${UI_USAGE_LEDGER_PATH} (${usageTotal(usage, "plain-button")} plain buttons, ` +
        `${usageTotal(usage, "raw-kbd")} raw <kbd>).`,
    );
  } else {
    const errors = [
      ...exceptionMismatches(readCommittedNoNativeUiExceptions(), exceptions),
      ...usageMismatches(readCommittedUiUsage(), usage),
    ];
    console.log(
      errors.length === 0 ? "UI drift ledgers match." : errors.join("\n"),
    );
  }
}

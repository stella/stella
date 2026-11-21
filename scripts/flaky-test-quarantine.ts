// Flaky-test quarantine registry.
//
// A quarantined Bun test keeps running in CI, but the preload
// (scripts/flaky-test-quarantine-preload.ts) records its failure instead of
// failing the process, so one known flake cannot eject a merge-queue entry.
// Every entry names an owner and expires: the dated-waiver inventory annotates
// an elapsed entry on pull requests and merge groups, and the scheduled
// flaky-test-quarantine workflow fails on main with one owner annotation per
// elapsed entry.
//
//   bun scripts/flaky-test-quarantine.ts digest
//     Prints the cache identity of the quarantine (registry and its runtime).
//   bun scripts/flaky-test-quarantine.ts expired --json <out.json>
//     Writes the elapsed entries, annotates each and exits 1 when any exist.

import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";
import { createSha256 } from "@stll/sha256/bun";

export const REGISTRY_FILE = "scripts/flaky-test-quarantine.json";
export const PRELOAD_FILE = "scripts/flaky-test-quarantine-preload.ts";
export const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..");
// A quarantine is a short-lived promise to fix the test, not a skip list.
export const MAX_QUARANTINE_DAYS = 30;
export const DAY_MS = 86_400_000;
// The preload wraps Bun's runner; Playwright and Rust tests are out of reach.
export const BUN_TEST_FILE = /\.test\.[cm]?[jt]sx?$/u;
const TEST_ID_SEPARATOR = "::";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const GITHUB_LOGIN = /^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/u;
const GITHUB_OWNER = new RegExp(
  `^(?:${GITHUB_LOGIN.source.slice(1, -1)})(?:/[a-z\\d_-]+)?$`,
  "u",
);

// An out-of-range day or month passes the pattern but is an Invalid Date, which
// toISOString would throw on; it is an invalid value, not a crash.
const isCalendarDate = (value: string): boolean => {
  if (!ISO_DATE.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
};

export type TestIdentity = { readonly file: string; readonly name: string };

/** `<repository path>::<full Bun test name>`, the name joined by ` > `. */
export const testId = ({ file, name }: TestIdentity): string =>
  `${file}${TEST_ID_SEPARATOR}${name}`;

export const splitTestId = (id: string): TestIdentity | undefined => {
  const index = id.indexOf(TEST_ID_SEPARATOR);
  if (index === -1) {
    return undefined;
  }
  const file = id.slice(0, index);
  const name = id.slice(index + TEST_ID_SEPARATOR.length);
  if (
    !BUN_TEST_FILE.test(file) ||
    path.posix.isAbsolute(file) ||
    path.posix.normalize(file) !== file ||
    file.startsWith("../") ||
    name.trim() !== name ||
    name === ""
  ) {
    return undefined;
  }
  return { file, name };
};

const dateSchema = v.pipe(
  v.string(),
  v.check(isCalendarDate, "must be a calendar date (YYYY-MM-DD)"),
);

const entrySchema = v.strictObject({
  id: v.pipe(
    v.string(),
    v.check(
      (id) => splitTestId(id) !== undefined,
      "must be `<repository path to a Bun *.test.* file>::<full test name>`",
    ),
  ),
  owner: v.pipe(
    v.string(),
    v.regex(
      GITHUB_OWNER,
      "must be a GitHub login or org/team slug without `@`",
    ),
  ),
  reason: v.pipe(
    v.string(),
    v.check(
      (reason) => reason.trim() === reason && reason !== "",
      "must be non-empty trimmed text",
    ),
    v.maxLength(500),
  ),
  created: dateSchema,
  expires: dateSchema,
});

const registrySchema = v.strictObject({ entries: v.array(entrySchema) });

export type QuarantineEntry = v.InferOutput<typeof entrySchema>;

// The preload writes one JSON line per event into this directory; the
// registry path override lets tests run the preload against fixture trees.
export const QUARANTINE_REPORT_DIR_ENV = "FLAKY_TEST_QUARANTINE_REPORT_DIR";
export const QUARANTINE_REGISTRY_ENV = "FLAKY_TEST_QUARANTINE_REGISTRY";

export const quarantineRecordSchema = v.variant("type", [
  // A file with quarantine entries started registering tests.
  v.strictObject({ type: v.literal("loaded"), file: v.string() }),
  v.strictObject({ type: v.literal("registered"), id: v.string() }),
  v.strictObject({
    type: v.literal("passed"),
    id: v.string(),
    durationMs: v.number(),
  }),
  v.strictObject({
    type: v.literal("failed"),
    id: v.string(),
    durationMs: v.number(),
    message: v.string(),
  }),
]);
export type QuarantineRecord = v.InferOutput<typeof quarantineRecordSchema>;
export type Registry = { readonly entries: readonly QuarantineEntry[] };

export type ParsedRegistry =
  | { readonly status: "valid"; readonly registry: Registry }
  | { readonly status: "invalid"; readonly errors: readonly string[] };

// Date-only expiry admits the whole UTC day, as scripts/dated-waivers.ts
// `expiryInstant` does; the registry test binds the two.
export const expiresAtMs = (entry: Pick<QuarantineEntry, "expires">): number =>
  Date.parse(`${entry.expires}T00:00:00.000Z`) + DAY_MS;

export const isExpired = (
  entry: Pick<QuarantineEntry, "expires">,
  now: Date,
): boolean => expiresAtMs(entry) <= now.getTime();

export const parseRegistry = (value: unknown): ParsedRegistry => {
  const parsed = v.safeParse(registrySchema, value);
  if (!parsed.success) {
    return {
      status: "invalid",
      errors: parsed.issues.map(
        (issue) => `${v.getDotPath(issue) ?? "registry"}: ${issue.message}`,
      ),
    };
  }
  const errors: string[] = [];
  const { entries } = parsed.output;
  for (const [index, entry] of entries.entries()) {
    const span =
      Date.parse(`${entry.expires}T00:00:00.000Z`) -
      Date.parse(`${entry.created}T00:00:00.000Z`);
    if (span < 0) {
      errors.push(`${entry.id}: expires before it was created`);
    } else if (span > MAX_QUARANTINE_DAYS * DAY_MS) {
      errors.push(
        `${entry.id}: quarantine spans more than ${MAX_QUARANTINE_DAYS} days`,
      );
    }
    const previous = entries.at(index - 1);
    if (index > 0 && previous && compareCodeUnit(previous.id, entry.id) >= 0) {
      errors.push(
        `${entry.id}: entries must be sorted by id without duplicates`,
      );
    }
  }
  return errors.length > 0
    ? { status: "invalid", errors }
    : { status: "valid", registry: parsed.output };
};

export const readRegistry = (
  file = path.join(REPOSITORY_ROOT, REGISTRY_FILE),
): Registry => {
  const parsed = parseRegistry(JSON.parse(readFileSync(file, "utf-8")));
  if (parsed.status === "invalid") {
    return panic(`Invalid ${file}:\n${parsed.errors.join("\n")}`);
  }
  return parsed.registry;
};

/** The canonical file text: proposals and removals write exactly this. */
export const serializeRegistry = (registry: Registry): string =>
  `${JSON.stringify(
    {
      entries: registry.entries.toSorted((left, right) =>
        compareCodeUnit(left.id, right.id),
      ),
    },
    null,
    2,
  )}\n`;

// A Turbo task replays a cached pass only while the quarantine that produced
// it is unchanged, so CI hashes this digest into every task of a quarantined
// test step.
export const quarantineDigest = (
  read: (file: string) => string = (file) =>
    readFileSync(path.join(REPOSITORY_ROOT, file), "utf-8"),
): string => {
  const hash = createSha256();
  for (const file of [
    REGISTRY_FILE,
    "scripts/flaky-test-quarantine.ts",
    PRELOAD_FILE,
  ]) {
    hash.update(`${file}\0${read(file)}\0`);
  }
  return hash.digest("hex");
};

export const annotationData = (value: string): string =>
  value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

export const annotationProperty = (value: string): string =>
  annotationData(value).replaceAll(",", "%2C").replaceAll(":", "%3A");

export const sourceLine = (content: string, id: string): number =>
  content
    .split("\n")
    .findIndex((line) => line.includes(`"id": ${JSON.stringify(id)}`)) + 1;

export const expiredAnnotations = (
  entries: readonly QuarantineEntry[],
  content: string,
): string[] =>
  entries.map(
    (entry) =>
      `::error file=${REGISTRY_FILE},line=${sourceLine(content, entry.id)},title=${annotationProperty("Flaky-test quarantine expired")}::${annotationData(`${entry.id} expired at the end of ${entry.expires} (owner: ${entry.owner}). Fix the test and remove the entry.`)}`,
  );

if (import.meta.main) {
  const [command = "", ...rest] = process.argv.slice(2);
  switch (command) {
    case "digest":
      console.log(quarantineDigest());
      break;
    case "expired": {
      const out = rest[0] === "--json" ? rest[1] : undefined;
      if (rest.length !== 2 || out === undefined) {
        panic(
          "Usage: bun scripts/flaky-test-quarantine.ts expired --json <out.json>",
        );
      }
      const content = readFileSync(
        path.join(REPOSITORY_ROOT, REGISTRY_FILE),
        "utf-8",
      );
      const now = new Date();
      const expired = readRegistry().entries.filter((entry) =>
        isExpired(entry, now),
      );
      writeFileSync(out, `${JSON.stringify(expired, null, 2)}\n`);
      for (const annotation of expiredAnnotations(expired, content)) {
        console.log(annotation);
      }
      if (expired.length > 0) {
        process.exitCode = 1;
      }
      break;
    }
    default:
      panic(
        "Usage: bun scripts/flaky-test-quarantine.ts <digest | expired --json <out.json>>",
      );
  }
}

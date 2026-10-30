import { panic } from "better-result";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import {
  aggregateLockBaseline,
  aggregateLockBaselineProblems,
  type AggregateLockBaselineRow,
  type AggregateLockRekey,
  aggregateLockSites,
  aggregateLockSourceIncluded,
} from "../.oxlint-plugins/aggregate-lock-sites.ts";
import { BASELINE_PATHS } from "./baseline-paths";

export { aggregateLockSourceIncluded } from "../.oxlint-plugins/aggregate-lock-sites.ts";

export const AGGREGATE_LOCK_BASELINE_PATH = BASELINE_PATHS.aggregateLocks;
const baselineSchema = v.array(
  v.object({
    file: v.string(),
    fingerprint: v.string(),
    count: v.number(),
    reason: v.string(),
  }),
);
export const parseAggregateLockBaseline = (text: string) =>
  v.parse(baselineSchema, JSON.parse(text));

/** One reviewed file per PR, named after it: `scripts/aggregate-lock-rekeys/<pr-slug>.json`. */
export const AGGREGATE_LOCK_REKEYS_DIR = "scripts/aggregate-lock-rekeys";
const rekeySchema = v.array(
  v.strictObject({
    file: v.string(),
    from: v.string(),
    to: v.string(),
    fromFile: v.optional(v.string()),
    reason: v.pipe(v.string(), v.trim(), v.minLength(1)),
  }),
);
export const parseAggregateLockRekeys = (text: string): AggregateLockRekey[] =>
  v.parse(rekeySchema, JSON.parse(text));
const readAggregateLockRekeys = (): AggregateLockRekey[] =>
  existsSync(AGGREGATE_LOCK_REKEYS_DIR)
    ? readdirSync(AGGREGATE_LOCK_REKEYS_DIR)
        .filter((name) => name.endsWith(".json"))
        .toSorted()
        .flatMap((name) =>
          parseAggregateLockRekeys(
            readFileSync(path.join(AGGREGATE_LOCK_REKEYS_DIR, name), "utf-8"),
          ),
        )
    : [];

/**
 * Every advisory aggregate's first-key namespace, as the API's census test
 * renders it. Workers of two releases run side by side during a deployment, so
 * a namespace is a deployed contract: an aggregate keeps the one its base
 * revision records, and a new aggregate never takes one the base already uses.
 * Removing an aggregate removes its row.
 */
export const AGGREGATE_LOCK_NAMESPACES_PATH =
  "apps/api/src/lib/db/aggregate-lock-namespaces.json";
const AGGREGATE_LOCK_OWNER_PATH = "apps/api/src/lib/db/aggregate-lock.ts";
const namespaceLedgerSchema = v.record(
  v.string(),
  v.pipe(v.string(), v.minLength(1)),
);
export const parseAggregateLockNamespaces = (
  text: string,
): Record<string, string> => v.parse(namespaceLedgerSchema, JSON.parse(text));

/**
 * The namespaces an owner revision without a ledger declares, read from its
 * `advisoryResource` cases in the census test's notation: a hexadecimal
 * literal or named hexadecimal constant is written out, anything else
 * interpolated is an identity.
 */
export const aggregateLockNamespacesFromSource = (
  source: string,
): Record<string, string> => {
  const constants = new Map(
    [...source.matchAll(/^const ([A-Z_]+) = (0x[0-9a-f_]+);$/gmu)].map(
      (match) => [match[1] ?? "", match[2] ?? ""] as const,
    ),
  );
  const owner =
    /\nconst advisoryResource = [\s\S]*?\n\};\n/u.exec(source)?.at(0) ??
    panic("Missing advisory aggregate resources in the owner source");
  return Object.fromEntries(
    [...owner.matchAll(/case "(\w+)":[\s\S]*?first: sql`([^`]*)`/gu)].map(
      (match) =>
        [
          match[1] ?? panic("Missing advisory aggregate name"),
          (match[2] ?? "").replaceAll(
            /\$\{([^}]*)\}/gu,
            (_, expression: string) => {
              const literal =
                constants.get(expression.trim()) ?? expression.trim();
              return /^0x[0-9a-f_]+$/iu.test(literal)
                ? `0x${Number(literal.replaceAll("_", "")).toString(16).padStart(8, "0")}`
                : "<identity>";
            },
          ),
        ] as const,
    ),
  );
};

export const aggregateLockNamespaceProblems = ({
  current,
  previous,
}: {
  current: Readonly<Record<string, string>>;
  previous: Readonly<Record<string, string>>;
}): string[] => {
  const problems: string[] = [];
  const owners = new Map<string, string>();
  for (const [aggregate, namespace] of Object.entries(current)) {
    const other = owners.get(namespace);
    if (other !== undefined) {
      problems.push(
        `${aggregate}: advisory first-key namespace ${namespace} is also ${other}'s; give each aggregate its own.`,
      );
    }
    owners.set(namespace, aggregate);
  }
  const deployedOwners = new Map(
    Object.entries(previous).map(
      ([aggregate, namespace]) => [namespace, aggregate] as const,
    ),
  );
  for (const [aggregate, namespace] of Object.entries(current)) {
    const deployed = previous[aggregate];
    if (deployed !== undefined && deployed !== namespace) {
      problems.push(
        `${aggregate}: advisory first-key namespace changed from ${deployed} to ${namespace}; workers of the base revision still lock ${deployed}, so keep it.`,
      );
    }
    const deployedOwner = deployedOwners.get(namespace);
    if (deployed === undefined && deployedOwner !== undefined) {
      problems.push(
        `${aggregate}: advisory first-key namespace ${namespace} belongs to ${deployedOwner} on the base revision; choose one no revision has used.`,
      );
    }
  }
  return problems;
};

const git = (args: string[]) => {
  const result = Bun.spawnSync(["git", ...args]);
  if (result.exitCode !== 0) {
    panic(
      `Aggregate lock inventory git command failed: ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
};
type AggregateLockGitSource = { file: string; source: string };
export const parseAggregateLockGitBatch = (
  data: Buffer,
  files: readonly string[],
): AggregateLockGitSource[] => {
  const sources: AggregateLockGitSource[] = [];
  let offset = 0;
  for (const file of files) {
    const end = data.indexOf(10, offset);
    if (end === -1) {
      return panic("Incomplete aggregate lock source header");
    }
    const header = data.subarray(offset, end).toString("utf-8");
    offset = end + 1;
    if (header.endsWith(" missing")) {
      continue;
    }
    const sizeText = /^[a-f0-9]+ blob ([0-9]+)$/u.exec(header)?.at(1);
    if (sizeText === undefined) {
      return panic(`Invalid aggregate lock source header: ${header}`);
    }
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || data.at(offset + size) !== 10) {
      return panic("Incomplete aggregate lock source body");
    }
    sources.push({
      file,
      source: data.subarray(offset, offset + size).toString("utf-8"),
    });
    offset += size + 1;
  }
  if (offset !== data.length) {
    return panic("Unexpected aggregate lock source data");
  }
  return sources;
};
const aggregateLockBase = () => {
  const explicitBase = process.env["BASE_SHA"];
  const requestedBase = process.env["BASE_REF"] ?? "origin/main";
  return git(
    explicitBase
      ? ["rev-parse", "--verify", `${explicitBase}^{commit}`]
      : ["merge-base", "HEAD", requestedBase],
  ).trim();
};
const baseHasFile = (base: string, file: string) =>
  Bun.spawnSync(["git", "cat-file", "-e", `${base}:${file}`]).exitCode === 0;
const previousAggregateLockNamespaces = (base: string) => {
  if (baseHasFile(base, AGGREGATE_LOCK_NAMESPACES_PATH)) {
    return parseAggregateLockNamespaces(
      git(["show", `${base}:${AGGREGATE_LOCK_NAMESPACES_PATH}`]),
    );
  }
  // Bootstrap from the base owner source, so the first ledger cannot record
  // a namespace the deployed code does not use.
  return aggregateLockNamespacesFromSource(
    git(["show", `${base}:${AGGREGATE_LOCK_OWNER_PATH}`]),
  );
};
const previousAggregateLocks = (
  rows: readonly AggregateLockBaselineRow[],
  base: string,
) => {
  const existing = Bun.spawnSync([
    "git",
    "cat-file",
    "-e",
    `${base}:${AGGREGATE_LOCK_BASELINE_PATH}`,
  ]);
  if (existing.exitCode === 0) {
    return parseAggregateLockBaseline(
      git(["show", `${base}:${AGGREGATE_LOCK_BASELINE_PATH}`]),
    );
  }
  // Bootstrap is tied to the base source, so a newly introduced acquisition
  // cannot be enrolled merely by regenerating the first baseline.
  const files = [...new Set(rows.map((row) => row.file))].toSorted();
  if (files.length === 0) {
    return [];
  }
  const result = Bun.spawnSync(["git", "cat-file", "--batch"], {
    stdin: Buffer.from(files.map((file) => `${base}:${file}\n`).join("")),
  });
  if (result.exitCode !== 0) {
    return panic(
      `Aggregate lock source inventory failed: ${result.stderr.toString()}`,
    );
  }
  const sources = parseAggregateLockGitBatch(result.stdout, files);
  return aggregateLockBaseline(
    sources.flatMap(({ file, source }) => aggregateLockSites(file, source)),
  );
};
export const checkAggregateLocks = () => {
  const files = git(["ls-files"])
    .trim()
    .split("\n")
    .filter(aggregateLockSourceIncluded);
  const actual = aggregateLockBaseline(
    files.flatMap((file) =>
      aggregateLockSites(file, readFileSync(file, "utf-8")),
    ),
  );
  const baseline = parseAggregateLockBaseline(
    readFileSync(AGGREGATE_LOCK_BASELINE_PATH, "utf-8"),
  );
  const base = aggregateLockBase();
  return [
    ...aggregateLockBaselineProblems({
      actual,
      baseline,
      previous: previousAggregateLocks(baseline, base),
      rekeys: readAggregateLockRekeys(),
    }),
    ...aggregateLockNamespaceProblems({
      current: parseAggregateLockNamespaces(
        readFileSync(AGGREGATE_LOCK_NAMESPACES_PATH, "utf-8"),
      ),
      previous: previousAggregateLockNamespaces(base),
    }),
  ];
};
if (import.meta.main) {
  if (Bun.argv.includes("--generate")) {
    const files = git(["ls-files"])
      .trim()
      .split("\n")
      .filter(aggregateLockSourceIncluded);
    const existing = existsSync(AGGREGATE_LOCK_BASELINE_PATH)
      ? parseAggregateLockBaseline(
          readFileSync(AGGREGATE_LOCK_BASELINE_PATH, "utf-8"),
        )
      : [];
    const rekeys = readAggregateLockRekeys();
    const reasons = new Map([
      ...existing.map(
        (row) => [`${row.file}:${row.fingerprint}`, row.reason] as const,
      ),
      ...rekeys.map(
        (rekey) => [`${rekey.file}:${rekey.to}`, rekey.reason] as const,
      ),
    ]);
    const rows = aggregateLockBaseline(
      files.flatMap((file) =>
        aggregateLockSites(file, readFileSync(file, "utf-8")),
      ),
    ).map((row) => ({
      ...row,
      reason: reasons.get(`${row.file}:${row.fingerprint}`) ?? row.reason,
    }));
    const problems = aggregateLockBaselineProblems({
      actual: rows,
      baseline: rows,
      previous: previousAggregateLocks(rows, aggregateLockBase()),
      rekeys,
    });
    if (problems.length) {
      panic(problems.join("\n"));
    }
    writeFileSync(
      path.resolve(AGGREGATE_LOCK_BASELINE_PATH),
      `${JSON.stringify(rows, null, 2)}\n`,
    );
  } else {
    const problems = checkAggregateLocks();
    if (problems.length) {
      panic(problems.join("\n"));
    }
    console.log("Aggregate lock inventory matches its shrinking baseline.");
  }
}

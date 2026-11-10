import { panic } from "better-result";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import {
  aggregateLockBaseline,
  aggregateLockBaselineProblems,
  type AggregateLockBaselineRow,
  type AggregateLockRekey,
  type AggregateLockSite,
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
    holder: v.optional(v.pipe(v.string(), v.minLength(1))),
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

/**
 * PostgreSQL refuses every row-locking clause (FOR UPDATE, FOR NO KEY UPDATE,
 * FOR SHARE, FOR KEY SHARE) unless the role holds UPDATE on the table or on
 * one of its columns; SELECT, DELETE or REFERENCES do not suffice. A legacy
 * row lock runs on the application role unless its baseline row names the
 * role that takes it (`holder`), and the privilege census must grant that
 * role UPDATE on every table the lock reaches. The aggregate owner's own row
 * locks are held to the same census by `aggregate-lock-privileges.test.ts`.
 */
export const ROLE_PRIVILEGE_CENSUS_PATH =
  "apps/api/src/lib/db/role-privilege-census.json";
export const SCHEMA_INDEX_DIR = "apps/api/src/db/schema-index";
const APPLICATION_ROLE = "stella";
/** A transaction on the database owner, which every grant check passes. */
const OWNER_HOLDER = "owner";
const censusSchema = v.object({
  public: v.array(v.string()),
  roles: v.array(
    v.object({ role: v.string(), privileges: v.array(v.string()) }),
  ),
});
/** Which tables each census role can row-lock. */
type RowLockGrants = ReadonlyMap<string, ReadonlySet<string>>;
export const parseRowLockGrants = (text: string): RowLockGrants => {
  const census = v.parse(censusSchema, JSON.parse(text));
  const lockable = (privileges: readonly string[]) =>
    new Set(
      [...privileges, ...census.public].flatMap((privilege) => {
        const table =
          /^(?:table:public\.([^:]+)|column:public\.([^.:]+)\.[^:]+):UPDATE:EFFECTIVE$/u.exec(
            privilege,
          );
        const name = table?.[1] ?? table?.[2];
        return name === undefined ? [] : [name];
      }),
    );
  return new Map(
    census.roles.map(({ role, privileges }) => [role, lockable(privileges)]),
  );
};
/** Each table's Drizzle export and SQL name, read from the schema index. */
export const parseSchemaTableNames = (
  indexSources: readonly string[],
): ReadonlyMap<string, string> =>
  new Map(
    indexSources.flatMap((source) =>
      [...source.matchAll(/^## (\S+) · `(\w+)`/gmu)].flatMap((match) => {
        const [, table, exported] = match;
        return table === undefined || exported === undefined
          ? []
          : [[table, table] as const, [exported, table] as const];
      }),
    ),
  );
type RowLockHolderOptions = {
  sites: readonly AggregateLockSite[];
  baseline: readonly AggregateLockBaselineRow[];
  grants: RowLockGrants;
  tables: ReadonlyMap<string, string>;
};
export const rowLockHolderProblems = ({
  sites,
  baseline,
  grants,
  tables,
}: RowLockHolderOptions): string[] => {
  const problems: string[] = [];
  if (!grants.has(APPLICATION_ROLE)) {
    problems.push(
      `The privilege census has no application role ${APPLICATION_ROLE}`,
    );
  }
  const holders = new Map(
    baseline.flatMap((row) =>
      row.holder === undefined
        ? []
        : [[`${row.file}:${row.fingerprint}`, row.holder] as const],
    ),
  );
  const rowLockKeys = new Set<string>();
  for (const site of sites) {
    if (site.rowLock === undefined) {
      continue;
    }
    const key = `${site.file}:${site.fingerprint}`;
    // Identical acquisitions share a baseline row and reach the same tables.
    if (rowLockKeys.has(key)) {
      continue;
    }
    rowLockKeys.add(key);
    const holder = holders.get(key) ?? APPLICATION_ROLE;
    const where = `${site.file}:${site.line}`;
    // A Drizzle table reached through a namespace (`schema.users`) is named
    // by its last member.
    const locked =
      site.rowLock.type === "unwritten"
        ? undefined
        : site.rowLock.relations.map((relation) =>
            tables.get(relation.split(".").at(-1) ?? relation),
          );
    const unresolved =
      locked === undefined || locked.some((table) => table === undefined);
    const applicationLocks = grants.get(APPLICATION_ROLE);
    const applicationCanLockAll =
      !unresolved &&
      applicationLocks !== undefined &&
      locked.every(
        (table) => table !== undefined && applicationLocks.has(table),
      );
    if (holder === OWNER_HOLDER) {
      if (applicationCanLockAll) {
        problems.push(
          `${where}: declares holder "${OWNER_HOLDER}" but role ${APPLICATION_ROLE} can lock what it locks; drop the holder`,
        );
      }
      continue;
    }
    if (holder === APPLICATION_ROLE && holders.has(key)) {
      problems.push(
        `${where}: holder "${APPLICATION_ROLE}" is the default; drop it`,
      );
    }
    const lockable = grants.get(holder);
    if (lockable === undefined) {
      problems.push(
        `${where}: holder "${holder}" is neither "${OWNER_HOLDER}" nor a role in ${ROLE_PRIVILEGE_CENSUS_PATH}`,
      );
      continue;
    }
    if (locked === undefined || unresolved) {
      problems.push(
        `${where}: cannot tell which table this row lock reaches; name the table at the site (\`.from(table)\`, \`OF table\`) or declare the baseline row's holder`,
      );
      continue;
    }
    for (const table of locked) {
      if (table !== undefined && !lockable.has(table)) {
        problems.push(
          `${where}: locks public.${table}, where role ${holder} has no UPDATE, so PostgreSQL refuses the lock; grant it, lock another row, or declare the baseline row's holder`,
        );
      }
    }
  }
  for (const key of holders.keys()) {
    if (!rowLockKeys.has(key)) {
      problems.push(`Holder on a baseline row that takes no row lock: ${key}`);
    }
  }
  return problems;
};
const readRowLockGrants = () =>
  parseRowLockGrants(readFileSync(ROLE_PRIVILEGE_CENSUS_PATH, "utf-8"));
const readSchemaTableNames = () =>
  parseSchemaTableNames(
    readdirSync(SCHEMA_INDEX_DIR)
      .filter((name) => name.endsWith(".md"))
      .map((name) => readFileSync(path.join(SCHEMA_INDEX_DIR, name), "utf-8")),
  );

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
  const sites = files.flatMap((file) =>
    aggregateLockSites(file, readFileSync(file, "utf-8")),
  );
  const actual = aggregateLockBaseline(sites);
  const baseline = parseAggregateLockBaseline(
    readFileSync(AGGREGATE_LOCK_BASELINE_PATH, "utf-8"),
  );
  const base = aggregateLockBase();
  return [
    ...rowLockHolderProblems({
      sites,
      baseline,
      grants: readRowLockGrants(),
      tables: readSchemaTableNames(),
    }),
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
    // A rekeyed row lock keeps the holder of the row it replaces.
    const holders = new Map<string, string>();
    const existingHolders = new Map(
      existing.map(
        (row) => [`${row.file}:${row.fingerprint}`, row.holder] as const,
      ),
    );
    for (const rekey of rekeys) {
      const holder = existingHolders.get(
        `${rekey.fromFile ?? rekey.file}:${rekey.from}`,
      );
      if (holder !== undefined) {
        holders.set(`${rekey.file}:${rekey.to}`, holder);
      }
    }
    for (const [key, holder] of existingHolders) {
      if (holder !== undefined) {
        holders.set(key, holder);
      }
    }
    const rows = aggregateLockBaseline(
      files.flatMap((file) =>
        aggregateLockSites(file, readFileSync(file, "utf-8")),
      ),
    ).map((row) => {
      const key = `${row.file}:${row.fingerprint}`;
      const holder = holders.get(key);
      return {
        ...row,
        reason: reasons.get(key) ?? row.reason,
        ...(holder === undefined ? {} : { holder }),
      };
    });
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

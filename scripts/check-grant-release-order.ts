import { panic } from "better-result";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * A public-law column grant reaches production as a declaration before it
 * reaches it as a grant: one release declares the column `permitted` with no
 * grant, and a later one adds the grant migration and may make it `required`.
 *
 * The runtime grant attestation holds the reader role to the running
 * release's own map and reads every grant outside it as over-privilege. A
 * migration that grants a column the production release has never declared
 * stops that release's tasks from starting while the rollout is in flight,
 * whether HEAD calls the column `required` or `permitted`. Production is
 * promoted from final releases, so a column first declared in a release
 * candidate still reaches production in one step: the comparison is against
 * the newest final release tag, never a candidate.
 */
export const GRANT_MAP_ENTRY = "apps/api/src/lib/public-law-relations.ts";
export const GRANT_MAP_EXPORT = "PUBLIC_LAW_COLUMN_GRANTS_BY_RELATION";
/** What the migrations grant, regenerated from a migrated database. */
export const ROLE_PRIVILEGE_CENSUS =
  "apps/api/src/lib/db/role-privilege-census.json";
/** The role the grant map governs. */
export const GRANT_MAP_ROLE = "stella_public_law_reader";

const LABEL = "grant-release-order";
const PRODUCTION_TAG = /^v(\d+)\.(\d+)\.(\d+)$/u;
const MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs"] as const;

export type ColumnGrants = Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

export type GrantReleaseOrderAllowance = {
  relation: string;
  column: string;
  /** The pull request that made or granted the column early. */
  pr: number;
  reason: string;
};

/**
 * Columns accepted as required or granted without a production release that
 * declares them.
 * Each entry names its pull request and why it is safe; an entry goes away
 * once a production release carries the column.
 */
export const GRANT_RELEASE_ORDER_ALLOWANCES: readonly GrantReleaseOrderAllowance[] =
  [];

export type GrantColumn = { relation: string; column: string };

const compareGrantColumns = (left: GrantColumn, right: GrantColumn): number => {
  const leftKey = `${left.relation}.${left.column}`;
  const rightKey = `${right.relation}.${right.column}`;
  if (leftKey === rightKey) {
    return 0;
  }
  return leftKey < rightKey ? -1 : 1;
};

/** Columns required at HEAD that the production release does not declare. */
export const findPrematureRequiredGrants = (
  head: ColumnGrants,
  released: ColumnGrants,
  allowances: readonly GrantReleaseOrderAllowance[] = [],
): GrantColumn[] => {
  const allowed = new Set(
    allowances.map(({ relation, column }) => `${relation}\u0000${column}`),
  );
  return Object.entries(head)
    .flatMap(([relation, columns]) =>
      Object.entries(columns)
        .filter(
          ([column, grant]) =>
            grant === "required" &&
            released[relation]?.[column] === undefined &&
            !allowed.has(`${relation}\u0000${column}`),
        )
        .map(([column]) => ({ relation, column })),
    )
    .toSorted(compareGrantColumns);
};

const CENSUS_COLUMN_GRANT =
  /^column:public\.([a-z0-9_]+)\.([a-z0-9_]+):SELECT:EFFECTIVE$/u;

/**
 * The `relation.column` pairs a census says `role` can select. Throws when
 * the census has no entry for the role, so a renamed role cannot read as a
 * role without grants.
 */
export const censusColumnGrants = (
  census: unknown,
  role: string = GRANT_MAP_ROLE,
): Set<string> => {
  const roles =
    typeof census === "object" && census !== null && "roles" in census
      ? census.roles
      : undefined;
  const entry = Array.isArray(roles)
    ? roles.find(
        (candidate: unknown) =>
          typeof candidate === "object" &&
          candidate !== null &&
          "role" in candidate &&
          candidate.role === role,
      )
    : undefined;
  const privileges: unknown =
    typeof entry === "object" && entry !== null && "privileges" in entry
      ? entry.privileges
      : undefined;
  if (!Array.isArray(privileges)) {
    return panic(`the role privilege census has no privileges for ${role}`);
  }
  return new Set(
    privileges.flatMap((privilege: unknown) => {
      const match =
        typeof privilege === "string"
          ? CENSUS_COLUMN_GRANT.exec(privilege)
          : null;
      return match === null ? [] : [`${match[1]}.${match[2]}`];
    }),
  );
};

/**
 * Columns HEAD's migrations grant that the production release neither
 * granted nor declares: that release would read the new grant as
 * over-privilege, `permitted` at HEAD or not.
 */
export const findUndeclaredNewGrants = (
  headGranted: ReadonlySet<string>,
  releasedGranted: ReadonlySet<string>,
  released: ColumnGrants,
  allowances: readonly GrantReleaseOrderAllowance[] = [],
): GrantColumn[] => {
  const allowed = new Set(
    allowances.map(({ relation, column }) => `${relation}.${column}`),
  );
  return [...headGranted]
    .filter((key) => !releasedGranted.has(key) && !allowed.has(key))
    .flatMap((key) => {
      const [relation = "", column = ""] = key.split(".");
      return released[relation]?.[column] === undefined
        ? [{ relation, column }]
        : [];
    })
    .toSorted(compareGrantColumns);
};

/** Allowances whose column the production release now declares. */
export const staleAllowances = (
  released: ColumnGrants,
  allowances: readonly GrantReleaseOrderAllowance[],
): GrantReleaseOrderAllowance[] =>
  allowances.filter(
    ({ relation, column }) => released[relation]?.[column] !== undefined,
  );

export const formatPrematureRequiredGrant = (
  { relation, column }: GrantColumn,
  tag: string,
): string =>
  `${LABEL}: ${relation}.${column} is "required" in ${GRANT_MAP_EXPORT}, but production release ${tag} does not declare it. ` +
  `Ship it as "permitted" first, and switch it to "required" in a pull request after the next production release.`;

export const formatUndeclaredNewGrant = (
  { relation, column }: GrantColumn,
  tag: string,
): string =>
  `${LABEL}: ${relation}.${column} is newly granted to ${GRANT_MAP_ROLE} (${ROLE_PRIVILEGE_CENSUS}), but production release ${tag} does not declare it in ${GRANT_MAP_EXPORT}. ` +
  `Declare it as "permitted" without the grant first, and add the grant migration in a pull request after the next production release.`;

const compareVersionsDescending = (left: string, right: string): number => {
  const leftParts = PRODUCTION_TAG.exec(left)?.slice(1).map(Number) ?? [];
  const rightParts = PRODUCTION_TAG.exec(right)?.slice(1).map(Number) ?? [];
  for (let index = 0; index < 3; index += 1) {
    const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

/**
 * The newest final `vX.Y.Z` tag cut from HEAD's history. Release tags sit on
 * the release branch's own commit, which main receives squashed, so a tag
 * qualifies when it shares history with HEAD rather than only when it is an
 * ancestor; tags of unrelated histories never do.
 */
export const selectProductionTag = (
  tags: readonly string[],
  sharesHistoryWithHead: (tag: string) => boolean,
): string | undefined =>
  tags
    .filter((tag) => PRODUCTION_TAG.test(tag))
    .toSorted(compareVersionsDescending)
    .find((tag) => sharesHistoryWithHead(tag));

const RELATIVE_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/gu;

/** Relative module specifiers a source file imports or re-exports. */
export const relativeImports = (source: string): string[] =>
  [...source.matchAll(RELATIVE_IMPORT)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );

type Git = (args: readonly string[]) => string | undefined;

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..");

const git: Git = (args) => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: REPOSITORY_ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0 ? result.stdout.toString() : undefined;
};

const resolveAtRevision = (
  revision: string,
  fromFile: string,
  specifier: string,
): string => {
  const base = path.posix.join(path.posix.dirname(fromFile), specifier);
  const candidates = [
    base,
    ...MODULE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...MODULE_EXTENSIONS.map((extension) => `${base}/index${extension}`),
  ];
  const found = candidates.find(
    (candidate) =>
      git(["cat-file", "-e", `${revision}:${candidate}`]) !== undefined,
  );
  if (found === undefined) {
    return panic(
      `${fromFile} at ${revision} imports ${specifier}, which does not exist at that revision`,
    );
  }
  return found;
};

/**
 * Writes the entry module and every module it reaches by a relative import,
 * as they are at `revision`, under `directory`. Package imports resolve from
 * the repository's own installation.
 */
const materializeAtRevision = (
  revision: string,
  entry: string,
  directory: string,
): void => {
  const pending = [entry];
  const written = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || written.has(file)) {
      continue;
    }
    const source = git(["show", `${revision}:${file}`]);
    if (source === undefined) {
      return panic(`cannot read ${file} at ${revision}`);
    }
    const target = path.join(directory, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, source);
    written.add(file);
    for (const specifier of relativeImports(source)) {
      pending.push(resolveAtRevision(revision, file, specifier));
    }
  }
};

const isColumnGrants = (value: unknown): value is ColumnGrants =>
  typeof value === "object" &&
  value !== null &&
  Object.values(value).every(
    (columns) =>
      typeof columns === "object" &&
      columns !== null &&
      Object.values(columns).every((grant) => typeof grant === "string"),
  );

const loadGrantMap = async (modulePath: string): Promise<ColumnGrants> => {
  const loaded: unknown = await import(pathToFileURL(modulePath).href);
  const grants =
    typeof loaded === "object" && loaded !== null && GRANT_MAP_EXPORT in loaded
      ? loaded[GRANT_MAP_EXPORT]
      : undefined;
  if (!isColumnGrants(grants)) {
    return panic(`${modulePath} does not export ${GRANT_MAP_EXPORT}`);
  }
  return grants;
};

const releasedGrantMap = async (tag: string): Promise<ColumnGrants> => {
  if (git(["cat-file", "-e", `${tag}:${GRANT_MAP_ENTRY}`]) === undefined) {
    // A release before the map existed declares no column at all.
    return {};
  }
  // Inside the repository so the module's package imports resolve.
  const cacheRoot = path.join(REPOSITORY_ROOT, "node_modules", ".cache");
  mkdirSync(cacheRoot, { recursive: true });
  const directory = mkdtempSync(path.join(cacheRoot, `${LABEL}-`));
  try {
    materializeAtRevision(tag, GRANT_MAP_ENTRY, directory);
    return await loadGrantMap(path.join(directory, GRANT_MAP_ENTRY));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const releasedCensusGrants = (tag: string): Set<string> => {
  const source = git(["show", `${tag}:${ROLE_PRIVILEGE_CENSUS}`]);
  // A release before the census existed is judged by its map alone.
  return source === undefined
    ? new Set()
    : censusColumnGrants(JSON.parse(source));
};

const main = async (): Promise<number> => {
  if (git(["rev-parse", "--is-shallow-repository"])?.trim() !== "false") {
    console.error(
      `${LABEL}: the checkout is shallow or not a Git repository; the check needs full history and tags (fetch-depth: 0).`,
    );
    return 1;
  }
  const tags = (git(["tag", "--list", "v*"]) ?? "")
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  const tag = selectProductionTag(
    tags,
    (candidate) => git(["merge-base", candidate, "HEAD"]) !== undefined,
  );
  if (tag === undefined) {
    console.error(
      `${LABEL}: no production release tag (vX.Y.Z) shares history with HEAD; fetch the repository's tags (fetch-depth: 0) before running this check.`,
    );
    return 1;
  }
  const head = await loadGrantMap(path.join(REPOSITORY_ROOT, GRANT_MAP_ENTRY));
  const released = await releasedGrantMap(tag);
  for (const allowance of staleAllowances(
    released,
    GRANT_RELEASE_ORDER_ALLOWANCES,
  )) {
    console.warn(
      `${LABEL}: ${allowance.relation}.${allowance.column} is declared by ${tag}; its allowance for #${allowance.pr} can be removed.`,
    );
  }
  const premature = findPrematureRequiredGrants(
    head,
    released,
    GRANT_RELEASE_ORDER_ALLOWANCES,
  );
  for (const grant of premature) {
    console.error(formatPrematureRequiredGrant(grant, tag));
  }
  const ungranted = findUndeclaredNewGrants(
    censusColumnGrants(
      JSON.parse(
        readFileSync(
          path.join(REPOSITORY_ROOT, ROLE_PRIVILEGE_CENSUS),
          "utf-8",
        ),
      ),
    ),
    releasedCensusGrants(tag),
    released,
    GRANT_RELEASE_ORDER_ALLOWANCES,
  );
  for (const grant of ungranted) {
    console.error(formatUndeclaredNewGrant(grant, tag));
  }
  const failures = premature.length + ungranted.length;
  if (failures === 0) {
    console.log(
      `${LABEL}: every required or newly granted column is declared by production release ${tag}`,
    );
  }
  return failures === 0 ? 0 : 1;
};

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`${LABEL}: ${String(error)}`);
    process.exitCode = 1;
  }
}

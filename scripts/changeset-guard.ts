#!/usr/bin/env bun

// Local mirror of the CI changeset gate.
//
// CI fails a pull request that touches a release-gated package's runtime files
// without adding a `.changeset/*.md` entry, but only once the whole workflow
// has run. This runs the same rule at pre-push, in about the time one
// `git diff` takes, and prints the remedy instead of a red check.
//
// Single source of truth: scripts/changeset-policy.json holds the pathspecs.
// The workflow feeds them to the shared changeset-policy action; this script
// matches them locally. Neither side owns a private copy, so they cannot
// drift.
//
// The shared action additionally validates entry shape and recognizes the
// generated version pull request. This guard also checks that packages named
// by added or edited entries have a changed release input: a release-gated
// file, or a root catalog version the package ships through `catalog:`,
// changed in the diff or since the package's last published version. A diff
// that changes such a catalog version must name every package that ships it.
// CI runs that same relevance check; empty entries remain valid no-release
// intent.
//
//   bun scripts/changeset-guard.ts [--base origin/main] [--packages-only]

import { readFileSync } from "node:fs";
import path from "node:path";

import { parseChangesetEntry } from "./changeset-entry";

// This module is also imported by the no-install Dependabot autofix runner.
class ChangesetPolicyError extends Error {
  readonly _tag = "ChangesetPolicyError";

  constructor(message: string) {
    super(message);
    this.name = "ChangesetPolicyError";
  }
}

const panic = (message: string): never => {
  throw new ChangesetPolicyError(message);
};

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const POLICY_FILE = "scripts/changeset-policy.json";
const DEFAULT_BASE = "origin/main";
const CHANGESET_DIRECTORY = ".changeset/";
const CHANGESET_EXTENSION = ".md";
/** Changesets ships this file; it is documentation, never a release entry. */
const CHANGESET_README = ".changeset/README.md";
const CHANGESET_PATHSPEC = ".changeset/*.md";
/** Bun reads workspace catalogs from the root manifest. */
const ROOT_MANIFEST = "package.json";
const NO_CATALOGS = "{}";
const CATALOG_PROTOCOL = "catalog:";
/** `catalog:` and `catalog:default` both name the top-level catalog. */
const DEFAULT_CATALOG = "default";
/** The sections a consumer installs; devDependencies never ship. */
const SHIPPED_DEPENDENCY_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
/** Keep the pre-push failure to three lines, however large the diff is. */
const PREVIEW_LIMIT = 3;

export type ChangesetPolicy = {
  readonly releasePaths: readonly string[];
  readonly generatedPaths: readonly string[];
  readonly packageFiles: readonly string[];
};

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isChangesetPolicy = (value: unknown): value is ChangesetPolicy =>
  typeof value === "object" &&
  value !== null &&
  "releasePaths" in value &&
  isStringArray(value.releasePaths) &&
  "generatedPaths" in value &&
  isStringArray(value.generatedPaths) &&
  "packageFiles" in value &&
  isStringArray(value.packageFiles);

export const parseChangesetPolicy = (text: string): ChangesetPolicy => {
  const parsed: unknown = JSON.parse(text);
  if (!isChangesetPolicy(parsed)) {
    return panic(
      `${POLICY_FILE} must hold releasePaths, generatedPaths and packageFiles as string arrays.`,
    );
  }
  return parsed;
};

export const loadChangesetPolicy = (
  root: string = REPO_ROOT,
): ChangesetPolicy =>
  parseChangesetPolicy(readFileSync(path.join(root, POLICY_FILE), "utf-8"));

/** The `directory/**` suffix, the only wildcard the policy file may use. */
const TREE_SUFFIX = "/**";
const WILDCARD = /[*?[\]]/u;

type ReleaseMatcher =
  | { readonly type: "file"; readonly file: string }
  | { readonly type: "tree"; readonly prefix: string };

/**
 * Git resolves the policy pathspecs in CI, this matcher resolves them locally,
 * so the supported syntax is deliberately tiny: a literal path, or a directory
 * followed by `/**`. Anything else fails loudly here rather than matching
 * differently on the two sides.
 */
export const parseReleasePathspec = (pathspec: string): ReleaseMatcher => {
  const isTree = pathspec.endsWith(TREE_SUFFIX);
  const literal = isTree ? pathspec.slice(0, -TREE_SUFFIX.length) : pathspec;
  if (literal.length === 0 || WILDCARD.test(literal)) {
    panic(
      `Unsupported release pathspec '${pathspec}'. Use a literal path or 'directory/**'.`,
    );
  }
  return isTree
    ? { type: "tree", prefix: `${literal}/` }
    : { type: "file", file: literal };
};

const matchesRelease = (matcher: ReleaseMatcher, file: string): boolean => {
  switch (matcher.type) {
    case "file":
      return file === matcher.file;
    case "tree":
      return file.startsWith(matcher.prefix);
    default: {
      matcher satisfies never;
      throw new ChangesetPolicyError(`Unhandled matcher: ${String(matcher)}`);
    }
  }
};

const releaseFileMatcher = (
  releasePaths: readonly string[],
): ((file: string) => boolean) => {
  const matchers = releasePaths.map(parseReleasePathspec);
  return (file) => matchers.some((matcher) => matchesRelease(matcher, file));
};

export const isChangesetEntry = (file: string): boolean =>
  file.startsWith(CHANGESET_DIRECTORY) &&
  file.endsWith(CHANGESET_EXTENSION) &&
  file !== CHANGESET_README;

/** A published package that ships a catalog entry whose version changed. */
export type CatalogInput = {
  readonly packageName: string;
  /** The manifest section that consumes it. */
  readonly field: (typeof SHIPPED_DEPENDENCY_FIELDS)[number];
  readonly dependency: string;
  /** The specifier as the manifest writes it: `jszip@catalog:`. */
  readonly entry: string;
};

export type ChangesetVerdict =
  | { readonly status: "not-required" }
  | { readonly status: "satisfied"; readonly changesets: readonly string[] }
  | {
      readonly status: "missing";
      readonly releaseFiles: readonly string[];
      readonly catalogInputs: readonly CatalogInput[];
    };

type ChangesetGateInput = {
  readonly changedFiles: readonly string[];
  readonly addedFiles: readonly string[];
  readonly releasePaths: readonly string[];
  /** Shipped catalog versions the diff changed, from `findCatalogInputs`. */
  readonly catalogInputs?: readonly CatalogInput[];
};

/**
 * The whole rule: a release-gated file in the diff, or a catalog version a
 * published package ships, needs a newly added changeset entry. The entry's
 * contents are deliberately not read — an empty changeset (`bun run changeset
 * --empty`) is how an intentional no-release change is recorded, and it must
 * pass exactly like a versioning one.
 */
export const decideChangesetGate = ({
  changedFiles,
  addedFiles,
  releasePaths,
  catalogInputs = [],
}: ChangesetGateInput): ChangesetVerdict => {
  const releaseFiles = changedFiles.filter(releaseFileMatcher(releasePaths));
  if (releaseFiles.length === 0 && catalogInputs.length === 0) {
    return { status: "not-required" };
  }

  const changesets = addedFiles.filter(isChangesetEntry);
  if (changesets.length > 0) {
    return { status: "satisfied", changesets };
  }
  return { status: "missing", releaseFiles, catalogInputs };
};

type JsonObject = Readonly<Record<string, unknown>>;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJsonObject = (text: string, file: string): JsonObject => {
  const parsed: unknown = JSON.parse(text);
  return isJsonObject(parsed)
    ? parsed
    : panic(`${file} must hold a JSON object.`);
};

const catalogSpecifier = (dependency: string, catalog: string): string =>
  `${dependency}@${CATALOG_PROTOCOL}${catalog === DEFAULT_CATALOG ? "" : catalog}`;

const catalogVersions = (catalog: unknown, name: string): [string, string][] =>
  Object.entries(isJsonObject(catalog) ? catalog : {}).flatMap(
    ([dependency, version]): [string, string][] =>
      typeof version === "string"
        ? [[catalogSpecifier(dependency, name), version]]
        : [],
  );

/**
 * Every catalog version the root manifest pins, keyed by the specifier a
 * workspace writes to consume it. Bun reads `catalog` and `catalogs` at the
 * top level or under an object-form `workspaces`.
 */
export const parseWorkspaceCatalogs = (
  rootManifest: string,
): ReadonlyMap<string, string> => {
  const manifest = parseJsonObject(rootManifest, ROOT_MANIFEST);
  const workspaces = manifest["workspaces"];
  const sources = isJsonObject(workspaces)
    ? [manifest, workspaces]
    : [manifest];
  const versions: [string, string][] = [];
  for (const source of sources) {
    const named = source["catalogs"];
    versions.push(
      ...catalogVersions(source["catalog"], DEFAULT_CATALOG),
      ...Object.entries(isJsonObject(named) ? named : {}).flatMap(
        ([name, catalog]) => catalogVersions(catalog, name),
      ),
    );
  }
  return new Map(versions);
};

/** The catalog entries a manifest ships to consumers. */
const shippedCatalogEntries = (
  manifest: JsonObject,
): Omit<CatalogInput, "packageName">[] =>
  SHIPPED_DEPENDENCY_FIELDS.flatMap((field) => {
    const dependencies = manifest[field];
    return Object.entries(
      isJsonObject(dependencies) ? dependencies : {},
    ).flatMap(([dependency, range]) =>
      typeof range === "string" && range.startsWith(CATALOG_PROTOCOL)
        ? [
            {
              field,
              dependency,
              entry: catalogSpecifier(
                dependency,
                range.slice(CATALOG_PROTOCOL.length).trim() || DEFAULT_CATALOG,
              ),
            },
          ]
        : [],
    );
  });

/** Workspace names follow @stll/<directory>, as the generated package lists do. */
const packageDirectories = (
  policy: ChangesetPolicy,
): ReadonlyMap<string, string> =>
  new Map(
    policy.packageFiles.map((file): [string, string] => {
      const directory = path.posix.dirname(file);
      return [`@stll/${path.posix.basename(directory)}`, `${directory}/`];
    }),
  );

type CatalogInputOptions = {
  readonly policy: ChangesetPolicy;
  /** Release-gated manifests keyed by path; a missing one ships nothing. */
  readonly manifests: ReadonlyMap<string, string>;
  /** Root manifests on the two sides of the comparison. */
  readonly before: string;
  readonly after: string;
};

/**
 * Publishing writes the catalog version into the packed manifest, so a
 * catalog bump changes what a published package ships although none of its
 * own files change. Private packages and devDependencies ship nothing.
 */
export const findCatalogInputs = ({
  policy,
  manifests,
  before,
  after,
}: CatalogInputOptions): CatalogInput[] => {
  const beforeVersions = parseWorkspaceCatalogs(before);
  const afterVersions = parseWorkspaceCatalogs(after);
  return [...packageDirectories(policy)].flatMap(([packageName, directory]) => {
    const file = `${directory}package.json`;
    const text = manifests.get(file);
    const manifest = text === undefined ? null : parseJsonObject(text, file);
    if (manifest === null || manifest["private"] === true) {
      return [];
    }
    return shippedCatalogEntries(manifest)
      .filter(
        ({ entry }) => beforeVersions.get(entry) !== afterVersions.get(entry),
      )
      .map(({ field, dependency, entry }) => ({
        packageName,
        field,
        dependency,
        entry,
      }));
  });
};

/**
 * A release in the same range already ships the new catalog version: the
 * version PR consumed the changeset and bumped the package, so a branch whose
 * merge base predates that release needs no second changeset.
 */
export const withoutReleasedPackages = (
  catalogInputs: readonly CatalogInput[],
  releasedPackages: ReadonlySet<string>,
): CatalogInput[] =>
  catalogInputs.filter(({ packageName }) => !releasedPackages.has(packageName));

const preview = (files: readonly string[]): string => {
  const shown = files.slice(0, PREVIEW_LIMIT).join(", ");
  const remaining = files.length - PREVIEW_LIMIT;
  return remaining > 0 ? `${shown} (+${remaining} more)` : shown;
};

/** What changed since a package's last published version. */
export type PublishedChanges = {
  /** The version tag, or the commit that set the version, for messages. */
  readonly reference: string;
  /** Files changed between that reference and HEAD. */
  readonly changedFiles: readonly string[];
  /** Shipped catalog versions that differ from that reference. */
  readonly catalogInputs: readonly CatalogInput[];
};

type ReleaseEvidence = Omit<PublishedChanges, "reference">;

type ChangesetPackageCheckOptions = {
  readonly changedFiles: readonly string[];
  readonly entries: readonly { file: string; contents: string }[];
  readonly policy: ChangesetPolicy;
  /** Shipped catalog versions the diff changed; each package must be named. */
  readonly catalogInputs?: readonly CatalogInput[];
  /** Per named package; null when no published reference resolved. */
  readonly published?: ReadonlyMap<string, PublishedChanges | null>;
};

type PackageTarget = {
  readonly name: string;
  readonly directory: string;
  readonly isRelease: (file: string) => boolean;
};

/** The package's changed release inputs: gated files, then catalog entries. */
const releaseInputs = (
  { changedFiles, catalogInputs }: ReleaseEvidence,
  { name, directory, isRelease }: PackageTarget,
): string[] => [
  ...changedFiles.filter(
    (file) => file.startsWith(directory) && isRelease(file),
  ),
  // One entry may be consumed from more than one section.
  ...new Set(
    catalogInputs
      .filter((input) => input.packageName === name)
      .map((input) => input.entry),
  ),
];

/**
 * Whether a named package has anything to release. The diff decides first;
 * otherwise everything since its last published version counts, which is how
 * a release catches up on inputs that landed without an entry. With no
 * published reference only the diff counts, and the note says so.
 */
const justifyPackage = (
  diff: ReleaseEvidence,
  since: PublishedChanges | null | undefined,
  target: PackageTarget,
): { readonly justified: boolean; readonly note?: string } => {
  const inDiff = releaseInputs(diff, target).length > 0;
  if (since === null) {
    return {
      justified: inDiff,
      note: `${target.name}: no published version reference resolved; checked this diff only.`,
    };
  }
  if (inDiff || since === undefined) {
    return { justified: inDiff };
  }
  const inputs = releaseInputs(since, target);
  return inputs.length > 0
    ? {
        justified: true,
        note: `${target.name}: changed since ${since.reference}: ${preview(inputs)}.`,
      }
    : { justified: false };
};

const requireCatalogPackagesNamed = (
  catalogInputs: readonly CatalogInput[],
  named: ReadonlySet<string>,
): void => {
  const unnamed = catalogInputs.filter(
    (input) => !named.has(input.packageName),
  );
  if (unnamed.length > 0) {
    panic(
      [
        "Catalog versions changed for published packages no changeset names:",
        ...unnamed.map((input) => `${input.packageName}: ${input.entry}`),
        "Run `bun run changeset` and name each package so its next release ships the new version.",
      ].join("\n"),
    );
  }
};

/**
 * Path evidence cannot establish semantic impact: comment-only edits count.
 * Returns how packages were justified beyond the diff, for the caller to print.
 */
export const checkChangesetPackages = ({
  changedFiles,
  entries,
  policy,
  catalogInputs = [],
  published,
}: ChangesetPackageCheckOptions): readonly string[] => {
  const isRelease = releaseFileMatcher(policy.releasePaths);
  const directories = packageDirectories(policy);
  const notes = new Set<string>();
  const named = new Set<string>();
  const unrelated: string[] = [];
  for (const { file, contents } of entries) {
    for (const name of parseChangesetEntry(contents).packages) {
      const directory =
        directories.get(name) ??
        panic(`${file} names a package outside the release policy: ${name}`);
      named.add(name);
      const { justified, note } = justifyPackage(
        { changedFiles, catalogInputs },
        published?.get(name),
        { name, directory, isRelease },
      );
      if (note !== undefined) {
        notes.add(note);
      }
      if (!justified) {
        unrelated.push(`${file}: ${name}`);
      }
    }
  }
  if (unrelated.length > 0) {
    panic(
      [
        "Changeset packages have no changed release-gated files or catalog versions since their last publish:",
        ...unrelated,
        ...notes,
        "Remove unrelated packages from the entry; run `bun run changeset --empty` for a no-release change.",
      ].join("\n"),
    );
  }
  requireCatalogPackagesNamed(catalogInputs, named);
  return [...notes];
};

export const report = (verdict: ChangesetVerdict): number => {
  switch (verdict.status) {
    case "not-required":
      process.stdout.write("changeset-guard: no release-gated changes.\n");
      return 0;
    case "satisfied":
      process.stdout.write(
        `changeset-guard: release-gated changes carry a changeset (${preview(verdict.changesets)}).\n`,
      );
      return 0;
    case "missing": {
      const catalog = verdict.catalogInputs.map(
        (input) => `${input.packageName} ships ${input.entry}`,
      );
      const lines = [
        "changeset-guard: release-gated files changed with no new changeset; CI fails on this.",
        ...(verdict.releaseFiles.length > 0
          ? [`  changed: ${preview(verdict.releaseFiles)}`]
          : []),
        ...(catalog.length > 0 ? [`  catalog: ${preview(catalog)}`] : []),
        "  fix: bun run changeset (add --empty for an intentional no-release change)",
      ];
      process.stderr.write(`${lines.join("\n")}\n`);
      return 1;
    }
    default: {
      verdict satisfies never;
      throw new ChangesetPolicyError(`Unhandled verdict: ${String(verdict)}`);
    }
  }
};

type GitRun = { readonly ok: boolean; readonly stdout: string };

const git = (args: readonly string[], cwd = REPO_ROOT): GitRun => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: result.exitCode === 0, stdout: result.stdout.toString() };
};

const gitPaths = (args: readonly string[], cwd = REPO_ROOT): string[] => {
  const result = git(args, cwd);
  if (!result.ok) {
    panic(`git ${args.join(" ")} failed`);
  }
  return result.stdout.split("\0").filter(Boolean);
};

/**
 * The two diffs the gate decides on, both read with `--no-renames`: a
 * maintenance release deletes the previous empty `.changeset/release-vX.md`
 * and adds a byte-identical `release-vY.md`, which git reports as a single
 * rename, so the added-entry query would come back empty and the guard would
 * refuse a commit that does carry a new entry.
 */
export const readChangesetDiff = ({
  mergeBase,
  root,
}: {
  readonly mergeBase: string;
  readonly root: string;
}): Pick<ChangesetGateInput, "addedFiles" | "changedFiles"> => ({
  changedFiles: gitPaths(
    [
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      "--diff-filter=ACMRD",
      mergeBase,
      "HEAD",
    ],
    root,
  ),
  addedFiles: gitPaths(
    [
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      "--diff-filter=A",
      mergeBase,
      "HEAD",
      "--",
      CHANGESET_PATHSPEC,
    ],
    root,
  ),
});

const commitOf = (ref: string): string | null => {
  const result = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return result.ok ? result.stdout.trim() : null;
};

const hasCommit = (ref: string): boolean => commitOf(ref) !== null;

/** A file as committed at `ref`, or null when it is not there. */
const readAt = (ref: string, file: string): string | null => {
  const result = git(["show", `${ref}:${file}`]);
  return result.ok ? result.stdout : null;
};

const manifestVersion = (text: string | null, file: string): unknown =>
  text === null ? undefined : parseJsonObject(text, file)["version"];

/** Packages whose own version changed between the ref and HEAD. */
const releasedSince = (
  policy: ChangesetPolicy,
  ref: string,
): ReadonlySet<string> =>
  new Set(
    [...packageDirectories(policy)].flatMap(([name, directory]) => {
      const file = `${directory}package.json`;
      return manifestVersion(readAt(ref, file), file) ===
        manifestVersion(readAt("HEAD", file), file)
        ? []
        : [name];
    }),
  );

/** Release-gated manifests at HEAD, keyed by path. */
const readManifests = (policy: ChangesetPolicy): ReadonlyMap<string, string> =>
  new Map(
    policy.packageFiles.flatMap((file): [string, string][] => {
      const text = readAt("HEAD", file);
      return text === null ? [] : [[file, text]];
    }),
  );

/**
 * The commit a package's current version was published from. The publish
 * workflow tags each release `<name>@<version>` and never moves the tag; a
 * clone without that tag falls back to the commit that last set the version,
 * the version commit the release is cut from.
 */
const resolvePublishedReference = (
  name: string,
  manifestFile: string,
  manifest: string,
): { readonly reference: string; readonly commit: string } | null => {
  const version = parseJsonObject(manifest, manifestFile)["version"];
  if (typeof version !== "string") {
    return null;
  }
  const tag = `${name}@${version}`;
  const tagged = commitOf(`refs/tags/${tag}`);
  if (tagged !== null) {
    return { reference: tag, commit: tagged };
  }
  const versionCommit = git([
    "log",
    "-1",
    "--format=%H",
    `-S"version": "${version}"`,
    "HEAD",
    "--",
    manifestFile,
  ]).stdout.trim();
  return versionCommit === ""
    ? null
    : {
        reference: `the commit that set ${version} (${versionCommit.slice(0, 10)}, no ${tag} tag)`,
        commit: versionCommit,
      };
};

type PublishedReadOptions = {
  readonly policy: ChangesetPolicy;
  readonly manifests: ReadonlyMap<string, string>;
  readonly headRoot: string;
};

const readPackagePublishedChanges = (
  { policy, manifests, headRoot }: PublishedReadOptions,
  name: string,
  directory: string,
): PublishedChanges | null => {
  const manifestFile = `${directory}package.json`;
  const manifest = manifests.get(manifestFile);
  if (manifest === undefined) {
    return null;
  }
  const reference = resolvePublishedReference(name, manifestFile, manifest);
  // An unreadable root manifest there must not read as every catalog version
  // having changed, so it counts as no reference.
  const rootAtReference =
    reference === null ? null : readAt(reference.commit, ROOT_MANIFEST);
  if (reference === null || rootAtReference === null) {
    return null;
  }
  return {
    reference: reference.reference,
    changedFiles: gitPaths([
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      reference.commit,
      "HEAD",
      "--",
      directory,
    ]),
    catalogInputs: findCatalogInputs({
      policy,
      manifests: new Map([[manifestFile, manifest]]),
      before: rootAtReference,
      after: headRoot,
    }),
  };
};

/** Release inputs changed since each named package's published version. */
const readPublishedChanges = (
  options: PublishedReadOptions,
  entries: readonly { file: string; contents: string }[],
): ReadonlyMap<string, PublishedChanges | null> => {
  const directories = packageDirectories(options.policy);
  const published = new Map<string, PublishedChanges | null>();
  for (const { contents } of entries) {
    for (const name of parseChangesetEntry(contents).packages) {
      const directory = directories.get(name);
      // The package check reports a name outside the policy.
      if (directory !== undefined && !published.has(name)) {
        published.set(
          name,
          readPackagePublishedChanges(options, name, directory),
        );
      }
    }
  }
  return published;
};

/**
 * Refresh a remote base before diffing: a stale one widens the diff with
 * commits that have since landed, and the package check would then credit a
 * changeset with an edit the change no longer carries, passing here and
 * failing in CI. Fetching one branch without tags keeps it under a second;
 * offline, the local ref is used as it is.
 */
const resolveBase = (base: string): string | null => {
  const separator = base.indexOf("/");
  if (separator > 0) {
    git([
      "fetch",
      "--quiet",
      "--no-tags",
      base.slice(0, separator),
      base.slice(separator + 1),
    ]);
  }
  return hasCommit(base) ? base : null;
};

const parseArgs = (args: readonly string[]) => {
  let base = DEFAULT_BASE;
  let check: "all" | "packages" = "all";
  const argv = args.values();
  for (const argument of argv) {
    if (argument === "--packages-only") {
      check = "packages";
      continue;
    }
    if (argument !== "--base") {
      panic(`Unknown argument: ${argument}`);
    }
    const value = argv.next().value;
    if (value === undefined) {
      return panic("--base requires a git ref");
    }
    base = value;
  }
  return { base, check };
};

const main = (args: readonly string[]): number => {
  const { base, check } = parseArgs(args);
  const resolved = resolveBase(base);
  if (resolved === null) {
    process.stderr.write(
      `changeset-guard: skipped, ${base} is not available locally.\n`,
    );
    return 0;
  }

  const mergeBase = git(["merge-base", resolved, "HEAD"]).stdout.trim();
  if (mergeBase === "") {
    process.stderr.write(
      `changeset-guard: skipped, no merge base with ${resolved}.\n`,
    );
    return 0;
  }

  const policy = loadChangesetPolicy();
  const diff = readChangesetDiff({ mergeBase, root: REPO_ROOT });
  const entries = gitPaths([
    "diff",
    "--no-renames",
    "--name-only",
    "-z",
    "--diff-filter=AM",
    mergeBase,
    "HEAD",
    "--",
    CHANGESET_PATHSPEC,
  ])
    .filter(isChangesetEntry)
    .map((file) => {
      // Read the same committed snapshot as the diff, not uncommitted edits.
      const result = git(["show", `HEAD:${file}`]);
      if (!result.ok) {
        return panic(`Could not read changeset at HEAD: ${file}`);
      }
      return { file, contents: result.stdout };
    });
  const manifests = readManifests(policy);
  // A tree without a root manifest has no catalogs to compare.
  const headRoot = readAt("HEAD", ROOT_MANIFEST) ?? NO_CATALOGS;
  const catalogInputs = diff.changedFiles.includes(ROOT_MANIFEST)
    ? withoutReleasedPackages(
        findCatalogInputs({
          policy,
          manifests,
          before: readAt(mergeBase, ROOT_MANIFEST) ?? NO_CATALOGS,
          after: headRoot,
        }),
        releasedSince(policy, mergeBase),
      )
    : [];
  const notes = checkChangesetPackages({
    changedFiles: diff.changedFiles,
    entries,
    policy,
    catalogInputs,
    published: readPublishedChanges({ policy, manifests, headRoot }, entries),
  });
  for (const note of notes) {
    process.stdout.write(`changeset-guard: ${note}\n`);
  }
  // CI leaves generated version-PR exemptions to the shared presence gate.
  if (check === "packages") {
    return 0;
  }
  return report(
    decideChangesetGate({
      ...diff,
      releasePaths: policy.releasePaths,
      catalogInputs,
    }),
  );
};

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}

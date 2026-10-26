// Resolve merge conflicts that sit only in generated outputs.
//
// When main moves under a same-repository pull request and the two sides
// conflict only in files a registered, autofix-eligible generator writes, the
// conflict carries no human decision: merge main, start each conflicted
// output from main's side, and let the owning generators rewrite it from the
// merged inputs. Any other conflicted path (source, lockfiles, baselines,
// files with hand-written regions, delete/modify) leaves the pull request to
// people.
//
// Three runs keep pull request code away from the push key and from caches
// other runs restore (see the three generated-conflicts workflows):
//
// 1. A run on main lists conflicting pull requests and dispatches one
//    resolve run per pull request, on that pull request's own branch.
// 2. The resolve run (untrusted, branch-scoped) calls `plan`, checks out the
//    planned starting tree, runs the generators and calls `collect`.
// 3. A run on main, triggered when that resolve run completes, calls `apply`
//    with main's copy of this file. It rebuilds the merge from git objects
//    alone (no work tree, no repository attributes), accepts only the owning
//    generators' outputs at paths whose parents are plain directories, and
//    requires the identical tree. `push` then creates the merge commit and
//    moves the branch with a compare-and-swap on the resolved head.
//
// It imports nothing outside this directory and needs no dependencies.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { isAutofixProtectedPath } from "./autofix-protected-paths";
import {
  allowedOutputs,
  type Generator,
  GENERATORS,
  generatorsForFiles,
  matchesGeneratedGlob,
  orderGenerators,
} from "./generated-files";

// Computed reads here are plans, manifests and git blobs copied into
// temporary trees; none is repository Markdown.
export const CI_MARKDOWN_READER_INPUTS: readonly string[] = [];

class GeneratedConflictsError extends Error {
  override name = "GeneratedConflictsError";
  readonly _tag = "GeneratedConflictsError";
}

// Annotated on the binding so control flow treats every call as an exit.
const fail: (message: string) => never = (message) => {
  throw new GeneratedConflictsError(message);
};

export type ConflictKind = "both-modified" | "both-added" | "delete-modify";

export type Conflict = { path: string; kind: ConflictKind };

export type Classification =
  | { eligible: true; conflicts: Conflict[]; ids: string[]; allowed: string[] }
  | { eligible: false; conflicts: Conflict[]; reasons: string[] };

const LOCKFILE =
  /(?:^|\/)(?:bun\.lockb?|Cargo\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|uv\.lock|poetry\.lock|Gemfile\.lock)$/u;

const SHA = /^[0-9a-f]{40}$/u;

const ownersOf = (
  file: string,
  generators: readonly Generator[],
  outputKinds: readonly Generator["outputKind"][] = ["committed"],
): Generator[] =>
  generators.filter(
    (generator) =>
      outputKinds.includes(generator.outputKind) &&
      generator.outputs.some((output) => matchesGeneratedGlob(output, file)),
  );

/**
 * Why the owners of `file` cannot take it over automatically, or null when
 * every owner writes the whole file and is autofix-eligible. Shared by the
 * regenerate and keep-deletion paths so both apply the same safeguards.
 */
const ownerReason = (
  file: string,
  owners: readonly Generator[],
): string | null => {
  if (owners.length === 0) {
    return `${file}: not a generated output`;
  }
  if (
    owners.some((owner) => owner.blocks?.some((block) => block.path === file))
  ) {
    // Only part of the file is generated; the conflict may be in prose.
    return `${file}: has hand-written regions`;
  }
  if (!owners.every((owner) => owner.autofix)) {
    return `${file}: its generator is not autofix-eligible`;
  }
  return null;
};

/** Why `conflict` needs a person, or null when its owner can regenerate it. */
const conflictReason = (
  conflict: Conflict,
  generators: readonly Generator[],
  deletions: ReadonlySet<string>,
): string | null => {
  const { path: file, kind } = conflict;
  if (LOCKFILE.test(file)) {
    return `${file}: lockfiles are resolved by people`;
  }
  if (isAutofixProtectedPath(file) || file.startsWith(".github/")) {
    return `${file}: a protected path`;
  }
  if (kind === "delete-modify") {
    return deletions.has(file) ? null : `${file}: one side deleted it`;
  }
  return ownerReason(file, ownersOf(file, generators));
};

/** Pure: decide whether every conflict is a regenerable output. */
export const classifyConflicts = (
  conflicts: readonly Conflict[],
  generators: readonly Generator[] = GENERATORS,
  deletions: ReadonlySet<string> = new Set(),
): Classification => {
  const sorted = conflicts.toSorted(
    // Byte order: paths are identifiers, not prose.
    (a, b) => Number(a.path > b.path) - Number(a.path < b.path),
  );
  if (sorted.length === 0) {
    return { eligible: false, conflicts: sorted, reasons: ["no conflicts"] };
  }
  const reasons = sorted.flatMap((conflict) => {
    const reason = conflictReason(conflict, generators, deletions);
    return reason === null ? [] : [reason];
  });
  if (reasons.length > 0) {
    return { eligible: false, conflicts: sorted, reasons };
  }
  const generatedFiles = sorted.flatMap(({ path: file, kind }) =>
    kind === "delete-modify" ? [] : [file],
  );
  const selected =
    generators === GENERATORS
      ? orderGenerators(generatorsForFiles(generatedFiles))
      : orderGenerators(
          generators.filter(
            (generator) =>
              generator.autofix &&
              [...generator.inputs, ...generator.outputs].some((glob) =>
                generatedFiles.some((file) => matchesGeneratedGlob(glob, file)),
              ),
          ),
        );
  return {
    eligible: true,
    conflicts: sorted,
    ids: selected.map(({ id }) => id),
    allowed: allowedOutputs(selected).filter(
      (output) => !isAutofixProtectedPath(output),
    ),
  };
};

const isPlainRelativePath = (file: string) =>
  file !== "" &&
  !file.startsWith("/") &&
  !file.includes("\\") &&
  !file.split("/").some((part) => part === "" || part === "." || part === "..");

/**
 * Pure: may a collected file land in the merge commit? Only a conflicted path
 * or a path an owning generator's output glob names itself; a file output
 * never stands for a directory.
 */
export const isAllowedResolution = (
  file: string,
  classification: Extract<Classification, { eligible: true }>,
) =>
  isPlainRelativePath(file) &&
  !isAutofixProtectedPath(file) &&
  !file.startsWith(".github/") &&
  !LOCKFILE.test(file) &&
  (classification.conflicts.some((conflict) => conflict.path === file) ||
    classification.allowed.some((output) =>
      matchesGeneratedGlob(output, file),
    ));

type StageEntry = { mode: string; sha: string; stage: string; path: string };

/** Pure: read `<mode> <sha> <stage>\t<path>` records (merge-tree, ls-files -u). */
export const parseStageEntries = (records: readonly string[]): StageEntry[] =>
  records.flatMap((record) => {
    const match = /^(\d{6}) ([0-9a-f]{40}) ([123])\t(.+)$/su.exec(record);
    if (!match?.[1] || !match[2] || !match[3] || match[4] === undefined) {
      return [];
    }
    return [{ mode: match[1], sha: match[2], stage: match[3], path: match[4] }];
  });

/** Pure: group stage entries into conflicts. */
export const conflictsOf = (entries: readonly StageEntry[]): Conflict[] => {
  const stages = new Map<string, Set<string>>();
  for (const entry of entries) {
    const seen = stages.get(entry.path) ?? new Set<string>();
    seen.add(entry.stage);
    stages.set(entry.path, seen);
  }
  return [...stages].map(([file, seen]) => {
    let kind: ConflictKind = "delete-modify";
    if (seen.has("2") && seen.has("3")) {
      kind = seen.has("1") ? "both-modified" : "both-added";
    }
    return { path: file, kind };
  });
};

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

type GitOptions = {
  input?: Uint8Array;
  index?: string;
  allowFailure?: boolean;
};

/**
 * Plumbing against a git directory only: no work tree is read or written,
 * repository attributes are ignored (`info/attributes` pins the plain text
 * merge driver; the attribute source is the empty tree), and no global or
 * system configuration can change how the merge resolves.
 */
const git = (
  gitDir: string,
  args: readonly string[],
  options: GitOptions = {},
) => {
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: tmpdir(),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  if (options.index !== undefined) {
    env["GIT_INDEX_FILE"] = options.index;
  }
  const result = Bun.spawnSync(
    [
      "git",
      `--git-dir=${gitDir}`,
      `--attr-source=${EMPTY_TREE}`,
      "-c",
      "core.bare=true",
      "-c",
      "core.attributesFile=/dev/null",
      "-c",
      "merge.renormalize=false",
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe", env, stdin: options.input ?? "ignore" },
  );
  if (result.exitCode !== 0 && !options.allowFailure) {
    fail(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return { exitCode: result.exitCode, stdout: result.stdout.toString() };
};

const neutralizeAttributes = (gitDir: string) => {
  mkdirSync(path.join(gitDir, "info"), { recursive: true });
  writeFileSync(
    path.join(gitDir, "info", "attributes"),
    "* merge=text conflict-marker-size=7\n",
  );
  // The empty tree is the attribute source; make sure the object exists.
  const created = Bun.spawnSync(
    [
      "git",
      `--git-dir=${gitDir}`,
      "hash-object",
      "-t",
      "tree",
      "-w",
      "--stdin",
    ],
    { stdin: new Uint8Array(), stdout: "pipe", stderr: "pipe" },
  );
  if (created.stdout.toString().trim() !== EMPTY_TREE) {
    fail("Cannot create the empty tree");
  }
};

const pathInTree = (gitDir: string, tree: string, file: string) =>
  git(gitDir, ["ls-tree", "-z", tree, "--", file]).stdout !== "";

/** Ask Git whether the ignore files stored in `tree` ignore `file`. */
export const ignoredInTree = (
  gitDir: string,
  tree: string,
  file: string,
): boolean => {
  const scratch = mkdtempSync(path.join(tmpdir(), "generated-ignore-"));
  try {
    // An empty template: no info/exclude from the Git installation, so only
    // the tree's own .gitignore files decide.
    const initialized = Bun.spawnSync(["git", "init", "-q", "--template="], {
      cwd: scratch,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: tmpdir(),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    if (initialized.exitCode !== 0) {
      fail(`git init failed: ${initialized.stderr.toString().trim()}`);
    }
    const records = git(gitDir, ["ls-tree", "-r", "-z", tree]).stdout.split(
      "\0",
    );
    for (const record of records) {
      const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/su.exec(
        record,
      );
      if (!match?.[2] || match[3] === undefined) {
        continue;
      }
      if (path.basename(match[3]) !== ".gitignore") {
        continue;
      }
      const target = path.join(scratch, match[3]);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, git(gitDir, ["cat-file", "blob", match[2]]).stdout);
    }
    const target = path.join(scratch, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "");
    return (
      Bun.spawnSync(["git", "check-ignore", "--no-index", "-q", "--", file], {
        cwd: scratch,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env["PATH"] ?? "/usr/bin:/bin",
          HOME: tmpdir(),
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      }).exitCode === 0
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

type DeletionsForOptions = {
  gitDir: string;
  head: string;
  main: string;
  conflicts: readonly Conflict[];
  generators: readonly Generator[];
};

const deletionsFor = ({
  gitDir,
  head,
  main,
  conflicts,
  generators,
}: DeletionsForOptions) =>
  conflicts
    .filter(
      ({ path: file, kind }) =>
        kind === "delete-modify" &&
        !LOCKFILE.test(file) &&
        !isAutofixProtectedPath(file) &&
        !file.startsWith(".github/") &&
        !pathInTree(gitDir, head, file) &&
        pathInTree(gitDir, main, file) &&
        ignoredInTree(gitDir, head, file) &&
        ownerReason(
          file,
          ownersOf(file, generators, ["committed", "derived"]),
        ) === null,
    )
    .map(({ path: file }) => file)
    .toSorted();

/** Build a tree from `base` with `edit` applied to a private index. */
const editTree = (
  gitDir: string,
  base: string,
  edit: (index: string) => void,
) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "generated-conflicts-"));
  const index = path.join(scratch, "index");
  try {
    git(gitDir, ["read-tree", base], { index });
    edit(index);
    return git(gitDir, ["write-tree"], { index }).stdout.trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

const removeFromIndex = (gitDir: string, index: string, file: string) => {
  git(gitDir, ["update-index", "-z", "--index-info"], {
    index,
    input: Buffer.from(`0 ${"0".repeat(40)}\t${file}\0`),
  });
};

export type Plan = Classification & {
  head: string;
  main: string;
  /** The merged tree with main's side of each conflicted output. */
  baseline: string | null;
  /** Conflicted generated outputs whose head-side deletion is preserved. */
  deletions: string[];
};

/** Merge `main` into `head` in memory and classify the conflicts. */
export const plan = (
  gitDir: string,
  head: string,
  main: string,
  generators: readonly Generator[] = GENERATORS,
): Plan => {
  if (!SHA.test(head) || !SHA.test(main)) {
    fail("head and main must be full commit SHAs");
  }
  neutralizeAttributes(gitDir);
  const merged = git(
    gitDir,
    ["merge-tree", "--write-tree", "-z", "--no-messages", head, main],
    { allowFailure: true },
  );
  if (merged.exitCode !== 0 && merged.exitCode !== 1) {
    fail(`git merge-tree failed with ${String(merged.exitCode)}`);
  }
  const [mergedTree = "", ...rest] = merged.stdout.split("\0");
  if (!SHA.test(mergedTree)) {
    fail("git merge-tree printed no tree");
  }
  const end = rest.indexOf("");
  const entries = parseStageEntries(end === -1 ? rest : rest.slice(0, end));
  const conflicts = conflictsOf(entries);
  const deletions = deletionsFor({
    gitDir,
    head,
    main,
    conflicts,
    generators,
  });
  const classification = classifyConflicts(
    conflicts,
    generators,
    new Set(deletions),
  );
  if (!classification.eligible) {
    return { ...classification, head, main, baseline: null, deletions };
  }
  const theirs = entries.filter((entry) => entry.stage === "3");
  const baseline = editTree(gitDir, mergedTree, (index) => {
    for (const entry of theirs) {
      git(
        gitDir,
        [
          "update-index",
          "--add",
          "--cacheinfo",
          `${entry.mode},${entry.sha},${entry.path}`,
        ],
        { index },
      );
    }
    for (const file of deletions) {
      removeFromIndex(gitDir, index, file);
    }
  });
  return { ...classification, head, main, baseline, deletions };
};

type ManifestFile = { path: string; deleted: boolean; mode: string };

type Manifest = {
  head: string;
  main: string;
  baseline: string;
  tree: string;
  deletions: string[];
  files: ManifestFile[];
};

const isManifest = (value: unknown): value is Manifest => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const files: unknown = Reflect.get(value, "files");
  const deletions: unknown = Reflect.get(value, "deletions");
  return (
    ["head", "main", "baseline", "tree"].every((key) =>
      SHA.test(String(Reflect.get(value, key))),
    ) &&
    Array.isArray(files) &&
    Array.isArray(deletions) &&
    deletions.every((file: unknown) => typeof file === "string") &&
    files.every(
      (file: unknown) =>
        typeof file === "object" &&
        file !== null &&
        typeof Reflect.get(file, "path") === "string" &&
        typeof Reflect.get(file, "deleted") === "boolean" &&
        ["100644", "100755"].includes(String(Reflect.get(file, "mode"))),
    )
  );
};

/** Every entry of `tree`, directories included, as path -> mode. */
const treeModes = (gitDir: string, tree: string) => {
  const modes = new Map<string, string>();
  for (const record of git(gitDir, [
    "ls-tree",
    "-r",
    "-t",
    "-z",
    tree,
  ]).stdout.split("\0")) {
    const match = /^(\d{6}) \w+ [0-9a-f]{40}\t(.+)$/su.exec(record);
    if (match?.[1] && match[2] !== undefined) {
      modes.set(match[2], match[1]);
    }
  }
  return modes;
};

/** Blob ids reachable from `tree`. */
const treeBlobs = (gitDir: string, tree: string) =>
  new Set(
    git(gitDir, ["ls-tree", "-r", "-z", tree])
      .stdout.split("\0")
      .flatMap((record) => {
        const match = /^\d{6} blob ([0-9a-f]{40})\t/u.exec(record);
        return match?.[1] ? [match[1]] : [];
      }),
  );

/**
 * Pure: why `file` cannot be written into a tree with these entries, or null.
 * Every parent must be a plain directory and the file itself a regular file
 * (or absent): a symlink or submodule anywhere on the path is refused.
 */
export const pathShapeProblem = (
  file: string,
  ...trees: readonly ReadonlyMap<string, string>[]
): string | null => {
  const parts = file.split("/");
  for (const modes of trees) {
    for (let depth = 1; depth < parts.length; depth += 1) {
      const parent = parts.slice(0, depth).join("/");
      const mode = modes.get(parent);
      if (mode !== undefined && mode !== "040000") {
        return `${file}: ${parent} is not a directory (${mode})`;
      }
    }
    const mode = modes.get(file);
    if (mode !== undefined && mode !== "100644" && mode !== "100755") {
      return `${file}: not a regular file (${mode})`;
    }
  }
  return null;
};

const readPlan = (
  file: string,
  generators: readonly Generator[] = GENERATORS,
): Plan => {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
  const read = (key: string): unknown =>
    typeof parsed === "object" && parsed !== null
      ? Reflect.get(parsed, key)
      : undefined;
  const [head, main, baseline, listed, storedDeletions] = [
    read("head"),
    read("main"),
    read("baseline"),
    read("conflicts"),
    read("deletions"),
  ];
  if (
    typeof head !== "string" ||
    typeof main !== "string" ||
    typeof baseline !== "string" ||
    !SHA.test(baseline) ||
    !Array.isArray(listed) ||
    !Array.isArray(storedDeletions) ||
    !storedDeletions.every((item: unknown) => typeof item === "string")
  ) {
    return fail(`${file} is not an eligible plan`);
  }
  // Re-derive the verdict rather than trust the stored one.
  const conflicts = listed.map((item: unknown): Conflict => {
    const conflictPath: unknown =
      typeof item === "object" && item !== null
        ? Reflect.get(item, "path")
        : undefined;
    const kind: unknown =
      typeof item === "object" && item !== null
        ? Reflect.get(item, "kind")
        : undefined;
    if (
      typeof conflictPath !== "string" ||
      (kind !== "both-modified" &&
        kind !== "both-added" &&
        kind !== "delete-modify")
    ) {
      return fail("Malformed conflict entry");
    }
    return { path: conflictPath, kind };
  });
  const deletions = storedDeletions.toSorted();
  return {
    ...classifyConflicts(conflicts, generators, new Set(deletions)),
    head,
    main,
    baseline,
    deletions,
  };
};

/** Resolve run: package what the generators wrote on top of the baseline. */
export const collect = ({
  repo,
  planFile,
  out,
  generators = GENERATORS,
}: {
  repo: string;
  planFile: string;
  out: string;
  generators?: readonly Generator[];
}) => {
  const planned = readPlan(planFile, generators);
  if (!planned.eligible || planned.baseline === null) {
    fail("collect needs an eligible plan");
  }
  const gitDir = path.join(repo, ".git");
  const run = (args: readonly string[]) => {
    const result = Bun.spawnSync(["git", "-C", repo, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      fail(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
    }
    return result.stdout.toString();
  };
  run(["add", "-A", "--", "."]);
  const tree = run(["write-tree"]).trim();
  const changed = run([
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    planned.baseline,
    tree,
  ])
    .split("\0")
    .filter(Boolean);
  const outside = changed.filter((file) => !isAllowedResolution(file, planned));
  if (outside.length > 0) {
    fail(
      `Regeneration changed files outside the owning generators' outputs:\n${outside.join("\n")}`,
    );
  }
  const modes = treeModes(gitDir, tree);
  const listed = [
    ...new Set([
      ...planned.conflicts.map(({ path: file }) => file),
      ...changed,
    ]),
  ].toSorted();
  rmSync(out, { recursive: true, force: true });
  mkdirSync(path.join(out, "files"), { recursive: true });
  const files = listed.map((file): ManifestFile => {
    const mode = modes.get(file);
    if (mode === undefined) {
      return { path: file, deleted: true, mode: "100644" };
    }
    const source = path.join(repo, file);
    if (!lstatSync(source).isFile()) {
      return fail(`${file} is not a regular file`);
    }
    const target = path.join(out, "files", file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(source));
    return { path: file, deleted: false, mode };
  });
  const manifest: Manifest = {
    head: planned.head,
    main: planned.main,
    baseline: planned.baseline,
    tree,
    deletions: planned.deletions,
    files,
  };
  writeFileSync(
    path.join(out, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
};

const MAX_FILE_BYTES = 20_000_000;

/** Refuse anything but plain files and directories in the collected data. */
const assertPlainTree = (root: string) => {
  for (const entry of readdirSync(root, {
    recursive: true,
    encoding: "utf-8",
  })) {
    const stat = lstatSync(path.join(root, entry));
    if (!stat.isFile() && !stat.isDirectory()) {
      fail(`The collected resolution contains a non-regular entry: ${entry}`);
    }
  }
};

export type ApplyOptions = {
  gitDir: string;
  head: string;
  /** Current tip of main; the manifest's main must be one of its ancestors. */
  mainTip: string;
  collected: string;
  out: string;
  generators?: readonly Generator[];
};

/**
 * Trusted: rebuild the merge from git objects, apply the collected files as
 * data, and write the API requests for one merge commit. Nothing is written
 * outside `out` and the git object store.
 */
export const apply = ({
  gitDir,
  head,
  mainTip,
  collected,
  out,
  generators = GENERATORS,
}: ApplyOptions) => {
  assertPlainTree(collected);
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(collected, "manifest.json"), "utf-8"),
  );
  if (!isManifest(parsed)) {
    fail("The collected manifest is malformed");
  }
  if (parsed.head !== head) {
    fail("The collected resolution is for a different head");
  }
  if (
    git(gitDir, ["merge-base", "--is-ancestor", parsed.main, mainTip], {
      allowFailure: true,
    }).exitCode !== 0
  ) {
    fail("The collected resolution merges a commit that is not on main");
  }
  const planned = plan(gitDir, head, parsed.main, generators);
  if (!planned.eligible || planned.baseline === null) {
    fail(
      `The merge is not generated-only:\n${planned.eligible ? "" : planned.reasons.join("\n")}`,
    );
  }
  if (planned.baseline !== parsed.baseline) {
    fail("The collected resolution started from a different merge");
  }
  if (planned.deletions.join("\0") !== parsed.deletions.toSorted().join("\0")) {
    fail("The collected resolution lists different deletions");
  }
  const headTree = git(gitDir, ["rev-parse", `${head}^{tree}`]).stdout.trim();
  const shapes = [
    treeModes(gitDir, headTree),
    treeModes(gitDir, planned.baseline),
  ];
  const uncovered = new Set(planned.conflicts.map(({ path: file }) => file));
  const seen = new Set<string>();
  for (const file of parsed.files) {
    if (seen.has(file.path)) {
      fail(`${file.path} is listed twice`);
    }
    seen.add(file.path);
    if (!isAllowedResolution(file.path, planned)) {
      fail(`${file.path} is outside the owning generators' outputs`);
    }
    const problem = pathShapeProblem(file.path, ...shapes);
    if (problem !== null) {
      fail(problem);
    }
    uncovered.delete(file.path);
  }
  if (uncovered.size > 0) {
    fail(
      `The collected resolution omits conflicted paths: ${[...uncovered].join(", ")}`,
    );
  }
  const tree = editTree(gitDir, planned.baseline, (index) => {
    for (const file of parsed.files) {
      if (file.deleted) {
        removeFromIndex(gitDir, index, file.path);
        continue;
      }
      const source = path.join(collected, "files", file.path);
      const stat = lstatSync(source);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
        fail(`${file.path} is not a plain file within the size limit`);
      }
      const sha = git(
        gitDir,
        ["hash-object", "-w", "--no-filters", "--stdin"],
        {
          input: readFileSync(source),
        },
      ).stdout.trim();
      git(
        gitDir,
        [
          "update-index",
          "--add",
          "--cacheinfo",
          `${file.mode},${sha},${file.path}`,
        ],
        { index },
      );
    }
  });
  if (tree !== parsed.tree) {
    fail(
      `The rebuilt tree ${tree} differs from the collected tree ${parsed.tree}`,
    );
  }
  // Describe the tree relative to the head. Blobs either parent already has
  // are referenced; every other blob, including ones the clean part of the
  // merge synthesized, is uploaded.
  const known = new Set([
    ...treeBlobs(gitDir, headTree),
    ...treeBlobs(gitDir, `${planned.main}^{tree}`),
  ]);
  const entries: {
    path: string;
    mode: string;
    type: "blob" | "commit";
    sha: string | null;
  }[] = [];
  const uploads = new Set<string>();
  const raw = git(gitDir, [
    "diff-tree",
    "-r",
    "--no-renames",
    "-z",
    headTree,
    tree,
  ]).stdout.split("\0");
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const meta = raw[index] ?? "";
    const file = raw[index + 1] ?? "";
    const match = /^:\d{6} (\d{6}) [0-9a-f]{40} ([0-9a-f]{40}) ([AMDT])$/u.exec(
      meta,
    );
    if (!match?.[1] || !match[2] || !match[3]) {
      fail(`Unexpected diff-tree record: ${meta}`);
    }
    if (match[3] === "D") {
      entries.push({ path: file, mode: "100644", type: "blob", sha: null });
      continue;
    }
    if (match[1] === "120000") {
      fail(`${file}: symlinks cannot travel through the API`);
    }
    const isSubmodule = match[1] === "160000";
    entries.push({
      path: file,
      mode: match[1],
      type: isSubmodule ? "commit" : "blob",
      sha: match[2],
    });
    if (!isSubmodule && !known.has(match[2])) {
      uploads.add(match[2]);
    }
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(path.join(out, "blobs"), { recursive: true });
  for (const sha of uploads) {
    const content = Bun.spawnSync(
      ["git", `--git-dir=${gitDir}`, "cat-file", "blob", sha],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (content.exitCode !== 0) {
      fail(`Cannot read blob ${sha}`);
    }
    writeFileSync(
      path.join(out, "blobs", `${sha}.json`),
      JSON.stringify({
        content: Buffer.from(content.stdout).toBase64(),
        encoding: "base64",
      }),
    );
  }
  writeFileSync(
    path.join(out, "tree.json"),
    JSON.stringify({ base_tree: headTree, tree: entries }),
  );
  writeFileSync(
    path.join(out, "commit.json"),
    JSON.stringify({
      message: `chore: merge main and regenerate conflicted generated files\n\nGenerated by: ${planned.ids.join(", ")}`,
      tree,
      parents: [head, planned.main],
    }),
  );
  writeFileSync(
    path.join(out, "expected.json"),
    JSON.stringify({ head, main: planned.main, tree }),
  );
};

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type PushOptions = {
  requests: string;
  repository: string;
  branch: string;
  token: string;
  api?: string;
  fetch?: Fetch;
  retryDelayMs?: number;
};

/**
 * Trusted: create the blobs, tree and merge commit, then move the branch with
 * a compare-and-swap: `updateRefs` applies only while the branch still points
 * at the head the resolution was built on, so a push or force-push in the
 * meantime is never overwritten or resurrected.
 */
export const push = async ({
  requests,
  repository,
  branch,
  token,
  api = "https://api.github.com",
  fetch: send = fetch,
  retryDelayMs = 2000,
}: PushOptions) => {
  const [owner, name] = repository.split("/");
  if (!owner || !name || !/^[A-Za-z0-9._/-]+$/u.test(branch)) {
    return fail("Invalid repository or branch");
  }
  // Git object writes are content-addressed, so repeating one after a server
  // error stores the same object; the ref update is never repeated.
  const call = async (route: string, body: unknown, attempts = 1) => {
    for (let attempt = 1; ; attempt += 1) {
      const response = await send(`${api}${route}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        const parsed: unknown = await response.json();
        return parsed;
      }
      if (response.status < 500 || attempt >= attempts) {
        return fail(`${route} answered ${String(response.status)}`);
      }
      await Bun.sleep(retryDelayMs * attempt);
    }
  };
  const field = (value: unknown, ...keys: string[]): unknown => {
    let current = value;
    for (const key of keys) {
      current =
        typeof current === "object" && current !== null
          ? Reflect.get(current, key)
          : undefined;
    }
    return current;
  };
  const expected: unknown = JSON.parse(
    readFileSync(path.join(requests, "expected.json"), "utf-8"),
  );
  const head = String(field(expected, "head"));
  const main = String(field(expected, "main"));
  const tree = String(field(expected, "tree"));
  const blobsDir = path.join(requests, "blobs");
  for (const file of existsSync(blobsDir) ? readdirSync(blobsDir) : []) {
    const sha = file.replace(/\.json$/u, "");
    const created = await call(
      `/repos/${repository}/git/blobs`,
      JSON.parse(readFileSync(path.join(blobsDir, file), "utf-8")),
      3,
    );
    if (field(created, "sha") !== sha) {
      return fail(
        `GitHub stored blob ${String(field(created, "sha"))}, not ${sha}`,
      );
    }
  }
  const createdTree = await call(
    `/repos/${repository}/git/trees`,
    JSON.parse(readFileSync(path.join(requests, "tree.json"), "utf-8")),
    3,
  );
  if (field(createdTree, "sha") !== tree) {
    return fail(
      `GitHub built tree ${String(field(createdTree, "sha"))}, not ${tree}`,
    );
  }
  const commit = await call(
    `/repos/${repository}/git/commits`,
    JSON.parse(readFileSync(path.join(requests, "commit.json"), "utf-8")),
    3,
  );
  const commitSha = String(field(commit, "sha"));
  const parents = field(commit, "parents");
  if (
    !SHA.test(commitSha) ||
    field(commit, "tree", "sha") !== tree ||
    !Array.isArray(parents) ||
    parents.map((parent: unknown) => field(parent, "sha")).join(" ") !==
      `${head} ${main}`
  ) {
    return fail("GitHub created a different merge commit");
  }
  const graphql = async (query: string, variables: Record<string, unknown>) => {
    const answer = await call("/graphql", { query, variables });
    const errors = field(answer, "errors");
    if (Array.isArray(errors) && errors.length > 0) {
      return fail(`GraphQL refused: ${JSON.stringify(errors)}`);
    }
    return answer;
  };
  const repo = await graphql(
    "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }",
    { owner, name },
  );
  const repositoryId = field(repo, "data", "repository", "id");
  if (typeof repositoryId !== "string") {
    return fail("Cannot resolve the repository id");
  }
  await graphql(
    "mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }",
    {
      input: {
        repositoryId,
        refUpdates: [
          {
            name: `refs/heads/${branch}`,
            beforeOid: head,
            afterOid: commitSha,
            force: false,
          },
        ],
      },
    },
  );
  return commitSha;
};

const option = (args: readonly string[], name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const required = (args: readonly string[], name: string) =>
  option(args, name) ?? fail(`${name} is required`);

if (import.meta.main) {
  const [mode = "", ...args] = process.argv.slice(2);
  switch (mode) {
    case "plan":
      console.log(
        JSON.stringify(
          plan(
            path.resolve(required(args, "--git-dir")),
            required(args, "--head"),
            required(args, "--main"),
          ),
        ),
      );
      break;
    case "collect":
      collect({
        repo: path.resolve(required(args, "--repo")),
        planFile: path.resolve(required(args, "--plan")),
        out: path.resolve(required(args, "--out")),
      });
      break;
    case "apply":
      apply({
        gitDir: path.resolve(required(args, "--git-dir")),
        head: required(args, "--head"),
        mainTip: required(args, "--main-tip"),
        collected: path.resolve(required(args, "--collected")),
        out: path.resolve(required(args, "--out")),
      });
      break;
    case "push": {
      const commit = await push({
        requests: path.resolve(required(args, "--requests")),
        repository: required(args, "--repository"),
        branch: required(args, "--branch"),
        token: process.env["GH_TOKEN"] ?? fail("GH_TOKEN is required"),
        api: process.env["GITHUB_API_URL"] ?? "https://api.github.com",
      });
      console.log(`Merged main into the branch as ${commit}`);
      break;
    }
    default:
      console.error(
        "Usage: bun scripts/generated-conflicts.ts plan|collect|apply|push (see the header)",
      );
      process.exitCode = 1;
  }
}

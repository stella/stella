// Resolve merge conflicts that sit only in generated outputs.
//
// When main moves under a same-repository pull request and the two sides
// conflict only in files a registered, autofix-eligible generator writes, the
// conflict carries no human decision: merge main, take main's side of each
// conflicted output, and let the owning generators rewrite them from the
// merged inputs. Any other conflicted path (source, lockfiles, baselines,
// files with hand-written regions, delete/modify) leaves the pull request to
// people.
//
// Three steps, split across jobs so pull request code never meets the push
// token (.github/workflows/autofix-generated-conflicts.yml):
//
//   merge      merges `--main` into the checkout and prints the
//              classification as JSON.
//   take-main  takes main's side of every conflicted output and prints the
//              resulting tree, the starting point for the generators.
//   collect    after the generators ran; writes a manifest and the
//              regenerated files, refusing anything outside the owning
//              generators' outputs.
//   prepare    trusted; repeats the merge, applies the collected files after
//              validating them as data, and writes the API requests for one
//              merge commit whose tree must equal the collected tree.
//
// It imports nothing outside this directory and runs without dependencies,
// so the trusted job runs it from main's checkout, never the branch's.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { isAutofixProtectedPath } from "./autofix-protected-paths";
import {
  GENERATORS,
  type Generator,
  allowedOutputs,
  generatorsForFiles,
  matchesGeneratedGlob,
  orderGenerators,
} from "./generated-files";

class GeneratedConflictsError extends Error {
  override name = "GeneratedConflictsError";
  readonly _tag = "GeneratedConflictsError";
}

export type ConflictKind = "both-modified" | "both-added" | "delete-modify";

export type Conflict = { path: string; kind: ConflictKind };

export type Classification =
  | { eligible: true; conflicts: Conflict[]; ids: string[]; allowed: string[] }
  | { eligible: false; conflicts: Conflict[]; reasons: string[] };

const LOCKFILE =
  /(?:^|\/)(?:bun\.lockb?|Cargo\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|uv\.lock|poetry\.lock|Gemfile\.lock)$/u;

const ownersOf = (
  file: string,
  generators: readonly Generator[],
): Generator[] =>
  generators.filter(
    (generator) =>
      generator.outputKind === "committed" &&
      generator.outputs.some((output) => matchesGeneratedGlob(output, file)),
  );

/** Why `conflict` needs a person, or null when its owner can regenerate it. */
const conflictReason = (
  conflict: Conflict,
  generators: readonly Generator[],
): string | null => {
  const { path: file, kind } = conflict;
  if (kind === "delete-modify") {
    return `${file}: one side deleted it`;
  }
  if (LOCKFILE.test(file)) {
    return `${file}: lockfiles are resolved by people`;
  }
  if (isAutofixProtectedPath(file) || file.startsWith(".github/workflows/")) {
    return `${file}: a protected path`;
  }
  const owners = ownersOf(file, generators);
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

/** Pure: decide whether every conflict is a regenerable output. */
export const classifyConflicts = (
  conflicts: readonly Conflict[],
  generators: readonly Generator[] = GENERATORS,
): Classification => {
  const sorted = conflicts.toSorted(
    // Byte order: paths are identifiers, not prose.
    (a, b) => Number(a.path > b.path) - Number(a.path < b.path),
  );
  if (sorted.length === 0) {
    return { eligible: false, conflicts: sorted, reasons: ["no conflicts"] };
  }
  const reasons = sorted.flatMap((conflict) => {
    const reason = conflictReason(conflict, generators);
    return reason === null ? [] : [reason];
  });
  if (reasons.length > 0) {
    return { eligible: false, conflicts: sorted, reasons };
  }
  const selected = orderGenerators(
    generatorsForFiles(sorted.map(({ path: file }) => file)),
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

/** Pure: may a collected file land in the merge commit? */
export const isAllowedResolution = (
  file: string,
  classification: Extract<Classification, { eligible: true }>,
) =>
  !isAutofixProtectedPath(file) &&
  !file.startsWith(".github/") &&
  !LOCKFILE.test(file) &&
  !file
    .split("/")
    .some((part) => part === ".." || part === "." || part === "") &&
  (classification.conflicts.some((conflict) => conflict.path === file) ||
    classification.allowed.some(
      (output) =>
        matchesGeneratedGlob(output, file) ||
        matchesGeneratedGlob(`${output}/**`, file),
    ));

/** Pure: read `git ls-files -u -z` output into conflicts. */
export const parseUnmerged = (output: string): Conflict[] => {
  const stages = new Map<string, Set<string>>();
  for (const record of output.split("\0")) {
    const match = /^\d{6} [0-9a-f]+ ([123])\t(.+)$/u.exec(record);
    if (!match?.[1] || match[2] === undefined) {
      continue;
    }
    const seen = stages.get(match[2]) ?? new Set<string>();
    seen.add(match[1]);
    stages.set(match[2], seen);
  }
  return [...stages].map(([file, seen]) => {
    let kind: ConflictKind = "delete-modify";
    if (seen.has("2") && seen.has("3")) {
      kind = seen.has("1") ? "both-modified" : "both-added";
    }
    return { path: file, kind };
  });
};

const git = (repo: string, args: readonly string[], allowFailure = false) => {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // The merge commit is created through the API; this identity never
      // reaches a pushed object.
      GIT_AUTHOR_NAME: "autofix",
      GIT_AUTHOR_EMAIL: "autofix@localhost",
      GIT_COMMITTER_NAME: "autofix",
      GIT_COMMITTER_EMAIL: "autofix@localhost",
    },
  });
  if (result.exitCode !== 0 && !allowFailure) {
    throw new GeneratedConflictsError(
      `git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`,
    );
  }
  return { ok: result.exitCode === 0, stdout: result.stdout.toString() };
};

const SHA = /^[0-9a-f]{40}$/u;

const requireSha = (value: string | undefined, name: string) => {
  if (value === undefined || !SHA.test(value)) {
    throw new GeneratedConflictsError(`${name} must be a full commit SHA`);
  }
  return value;
};

/** Merge `main` into the checkout without committing and classify. */
const merge = (repo: string, main: string): Classification => {
  git(repo, ["merge", "--no-commit", "--no-ff", "--no-edit", main], true);
  const unmerged = git(repo, ["ls-files", "-u", "-z"]).stdout;
  return classifyConflicts(parseUnmerged(unmerged));
};

/** Take main's side of each conflicted output so the generators start clean. */
const takeMain = (repo: string, conflicts: readonly Conflict[]) => {
  for (const { path: file } of conflicts) {
    git(repo, ["checkout", "--theirs", "--", file]);
    git(repo, ["add", "--", file]);
  }
};

type Manifest = {
  head: string;
  main: string;
  tree: string;
  files: { path: string; deleted: boolean }[];
};

const resolvedTree = (repo: string) => {
  git(repo, ["add", "-A", "--", "."]);
  if (git(repo, ["ls-files", "-u"]).stdout.trim() !== "") {
    throw new GeneratedConflictsError(
      "Unmerged paths remain after regeneration",
    );
  }
  return git(repo, ["write-tree"]).stdout.trim();
};

/** Paths whose content differs between two trees. */
const changedPaths = (repo: string, from: string, to: string) =>
  git(repo, ["diff", "--name-only", "--no-renames", "-z", from, to])
    .stdout.split("\0")
    .filter(Boolean);

const readClassification = (file: string) => {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray(Reflect.get(parsed, "conflicts"))
  ) {
    throw new GeneratedConflictsError(`${file} is not a classification`);
  }
  // Re-derive rather than trust the stored verdict.
  const conflicts: Conflict[] = [];
  for (const item of Reflect.get(parsed, "conflicts")) {
    const conflictPath: unknown = Reflect.get(item, "path");
    const kind: unknown = Reflect.get(item, "kind");
    if (
      typeof conflictPath !== "string" ||
      (kind !== "both-modified" &&
        kind !== "both-added" &&
        kind !== "delete-modify")
    ) {
      throw new GeneratedConflictsError("Malformed conflict entry");
    }
    conflicts.push({ path: conflictPath, kind });
  }
  const classification = classifyConflicts(conflicts);
  if (!classification.eligible) {
    throw new GeneratedConflictsError("The merge is not generated-only");
  }
  return classification;
};

type CollectOptions = {
  repo: string;
  head: string;
  main: string;
  plan: string;
  baseline: string;
  out: string;
};

const collect = ({ repo, head, main, plan, baseline, out }: CollectOptions) => {
  const classification = readClassification(plan);
  if (!SHA.test(baseline)) {
    throw new GeneratedConflictsError("--baseline must be a tree id");
  }
  // The generators already ran in the working tree; stage what they wrote.
  const tree = resolvedTree(repo);
  const files = changedPaths(repo, baseline, tree);
  const conflicted = classification.conflicts.map(({ path: file }) => file);
  const outside = files.filter(
    (file) => !isAllowedResolution(file, classification),
  );
  if (outside.length > 0) {
    throw new GeneratedConflictsError(
      `Regeneration changed files outside the owning generators' outputs:\n${outside.join("\n")}`,
    );
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(path.join(out, "files"), { recursive: true });
  const listed = [...new Set([...conflicted, ...files])].toSorted();
  const manifest: Manifest = {
    head,
    main,
    tree,
    files: listed.map((file) => {
      const source = path.join(repo, file);
      const deleted = !existsSync(source);
      if (!deleted) {
        if (!lstatSync(source).isFile()) {
          throw new GeneratedConflictsError(`${file} is not a regular file`);
        }
        const target = path.join(out, "files", file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(source));
      }
      return { path: file, deleted };
    }),
  };
  writeFileSync(
    path.join(out, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
};

const MAX_FILE_BYTES = 20_000_000;

const isManifest = (value: unknown): value is Manifest => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record: Record<string, unknown> = { ...value };
  return (
    typeof record["head"] === "string" &&
    typeof record["main"] === "string" &&
    typeof record["tree"] === "string" &&
    Array.isArray(record["files"]) &&
    record["files"].every(
      (file: unknown) =>
        typeof file === "object" &&
        file !== null &&
        typeof Reflect.get(file, "path") === "string" &&
        typeof Reflect.get(file, "deleted") === "boolean",
    )
  );
};

/** Trusted: rebuild the resolution from the collected data and plan the push. */
type PrepareOptions = {
  repo: string;
  head: string;
  main: string;
  collected: string;
  out: string;
};

const prepare = ({ repo, head, main, collected, out }: PrepareOptions) => {
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(collected, "manifest.json"), "utf-8"),
  );
  if (!isManifest(parsed)) {
    throw new GeneratedConflictsError("The collected manifest is malformed");
  }
  if (parsed.head !== head || parsed.main !== main || !SHA.test(parsed.tree)) {
    throw new GeneratedConflictsError(
      "The collected resolution is for a different merge",
    );
  }
  if (git(repo, ["rev-parse", "HEAD"]).stdout.trim() !== head) {
    throw new GeneratedConflictsError(
      "The checkout is not the pull request head",
    );
  }
  const classification = merge(repo, main);
  if (!classification.eligible) {
    throw new GeneratedConflictsError(
      `The merge is not generated-only:\n${classification.reasons.join("\n")}`,
    );
  }
  takeMain(repo, classification.conflicts);
  const conflicted = new Set(classification.conflicts.map(({ path: p }) => p));
  for (const { path: file, deleted } of parsed.files) {
    if (!isAllowedResolution(file, classification)) {
      throw new GeneratedConflictsError(
        `${file} is outside the owning generators' outputs`,
      );
    }
    conflicted.delete(file);
    const target = path.join(repo, file);
    if (deleted) {
      rmSync(target, { force: true });
      continue;
    }
    const source = path.join(collected, "files", file);
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      throw new GeneratedConflictsError(
        `${file} is not a plain file within the size limit`,
      );
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(source));
  }
  if (conflicted.size > 0) {
    throw new GeneratedConflictsError(
      `The collected resolution omits conflicted paths: ${[...conflicted].join(", ")}`,
    );
  }
  const tree = resolvedTree(repo);
  if (tree !== parsed.tree) {
    throw new GeneratedConflictsError(
      `The rebuilt tree ${tree} differs from the collected tree ${parsed.tree}`,
    );
  }
  // Describe the tree relative to the pull request head: unchanged entries
  // come from base_tree, main's files are referenced by their existing blob
  // ids, and only regenerated content is uploaded as new blobs.
  const regenerated = new Set(parsed.files.map(({ path: file }) => file));
  const entries: {
    path: string;
    mode: string;
    type: "blob" | "commit";
    sha: string | null;
  }[] = [];
  const uploads: { path: string; file: string }[] = [];
  const raw = git(repo, [
    "diff-tree",
    "-r",
    "--no-renames",
    "-z",
    `${head}^{tree}`,
    tree,
  ]).stdout.split("\0");
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const meta = raw[index] ?? "";
    const file = raw[index + 1] ?? "";
    const match = /^:\d{6} (\d{6}) [0-9a-f]{40} ([0-9a-f]{40}) ([AMDT])$/u.exec(
      meta,
    );
    if (!match?.[1] || !match[2] || !match[3]) {
      throw new GeneratedConflictsError(`Unexpected diff-tree record: ${meta}`);
    }
    if (match[3] === "D") {
      entries.push({ path: file, mode: "100644", type: "blob", sha: null });
      continue;
    }
    if (match[1] === "120000") {
      throw new GeneratedConflictsError(
        `${file}: symlinks cannot travel through the API`,
      );
    }
    entries.push({
      path: file,
      mode: match[1],
      type: match[1] === "160000" ? "commit" : "blob",
      sha: match[2],
    });
    if (regenerated.has(file)) {
      uploads.push({ path: file, file: path.join(repo, file) });
    }
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(path.join(out, "blobs"), { recursive: true });
  for (const [index, upload] of uploads.entries()) {
    writeFileSync(
      path.join(out, "blobs", `${String(index)}.json`),
      JSON.stringify({
        content: readFileSync(upload.file).toString("base64"),
        encoding: "base64",
      }),
    );
  }
  writeFileSync(
    path.join(out, "tree.json"),
    JSON.stringify({
      base_tree: git(repo, ["rev-parse", `${head}^{tree}`]).stdout.trim(),
      tree: entries,
    }),
  );
  writeFileSync(
    path.join(out, "commit.json"),
    JSON.stringify({
      message: `chore: merge main and regenerate conflicted generated files\n\nGenerated by: ${classification.ids.join(", ")}`,
      tree,
      parents: [head, main],
    }),
  );
  writeFileSync(path.join(out, "expected-tree"), `${tree}\n`);
};

const option = (args: readonly string[], name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

if (import.meta.main) {
  const [mode, ...args] = process.argv.slice(2);
  const repo = path.resolve(option(args, "--repo") ?? ".");
  switch (mode) {
    case "merge": {
      const main = requireSha(option(args, "--main"), "--main");
      console.log(JSON.stringify(merge(repo, main)));
      break;
    }
    case "take-main": {
      const classification = readClassification(
        path.resolve(option(args, "--plan") ?? ""),
      );
      takeMain(repo, classification.conflicts);
      console.log(git(repo, ["write-tree"]).stdout.trim());
      break;
    }
    case "collect":
      collect({
        repo,
        head: requireSha(option(args, "--head"), "--head"),
        main: requireSha(option(args, "--main"), "--main"),
        plan: path.resolve(option(args, "--plan") ?? ""),
        baseline: option(args, "--baseline") ?? "",
        out: path.resolve(option(args, "--out") ?? "generated-conflicts"),
      });
      break;
    case "prepare":
      prepare({
        repo,
        head: requireSha(option(args, "--head"), "--head"),
        main: requireSha(option(args, "--main"), "--main"),
        collected: path.resolve(option(args, "--collected") ?? ""),
        out: path.resolve(option(args, "--out") ?? "generated-conflicts-plan"),
      });
      break;
    default:
      console.error(
        "Usage: bun scripts/generated-conflicts.ts merge|take-main|collect|prepare --repo <dir> [--main <sha>] [--head <sha>] [--plan <file>] [--baseline <tree>] [--out <dir>] [--collected <dir>]",
      );
      process.exitCode = 1;
  }
}

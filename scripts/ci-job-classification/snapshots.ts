import { Result } from "better-result";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { compareCodeUnit } from "../../packages/collation/src/collation";
import { refreshJobClassificationDigests } from "../check-ci-job-classification";
import { decisionKeyFromPath } from "./decisions";
import { readClassificationInputs } from "./generate";
import { createGitProvider } from "./git-provider";
import { decisionPathForKey } from "./inputs";
import {
  parseRemoteReference,
  recordMetadataMount,
  resolveLocalMetadataPath,
  sameMetadataOrigin,
} from "./references";
import type { MetadataOrigin, MetadataReferenceKind } from "./references";
import { AdmissionError, parseDocument } from "./yaml";

type Snapshot = {
  origin: Extract<MetadataOrigin, { type: "git" }>;
  documents: Record<string, string>;
};
type Snapshots = Record<string, Snapshot>;
type Source = { directory: string; revision: string };

const sourceIdentity = (origin: Snapshot["origin"]) =>
  `${origin.owner}/${origin.repo}@${origin.sha}`;

const actionPath = (read: (file: string) => string, directory: string) => {
  for (const name of ["action.yml", "action.yaml"]) {
    const file = directory ? `${directory}/${name}` : name;
    try {
      read(file);
      return file;
    } catch {
      // Git has no portable existence probe in SourceProvider; preserve its
      // closed error if neither conventional action manifest exists.
    }
  }
  throw new AdmissionError({
    message: `Remote action metadata missing: ${directory}`,
  });
};

const nextSupplierKey = (root: string, snapshots: Snapshots) => {
  let greatest = 0;
  const history = Bun.spawnSync(
    [
      "git",
      "-C",
      root,
      "log",
      "-p",
      "--format=",
      "--",
      ".github/ci-job-classification-sources.json",
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const historicalKeys =
    history.exitCode === 0
      ? (new TextDecoder().decode(history.stdout).match(/supplier[0-9]+/gu) ??
        [])
      : [];
  for (const key of [...Object.keys(snapshots), ...historicalKeys]) {
    const match = /^supplier([0-9]+)$/u.exec(key);
    greatest = Math.max(greatest, match ? Number(match[1]) : 0);
  }
  return `supplier${greatest + 1}`;
};

type WriteSnapshotsOptions = {
  root: string;
  sources: Record<string, Source>;
  base?: string;
};

type ReconcileDecisionsOptions = {
  root: string;
  previous: Snapshots;
  retained: Snapshots;
  /** Removed supplier to its successor: decisions move. */
  replacements: ReadonlyMap<string, string>;
  /** Supplier still in use to the suppliers some of its pins moved to:
   * decisions are copied and the originals stay. */
  copies: ReadonlyMap<string, readonly string[]>;
};

const decisionKind = (file: string): unknown => {
  const decision: unknown = JSON.parse(readFileSync(file, "utf-8"));
  return typeof decision === "object" && decision !== null && "kind" in decision
    ? decision.kind
    : undefined;
};

const reconcileDecisions = ({
  root,
  previous,
  retained,
  replacements,
  copies,
}: ReconcileDecisionsOptions) => {
  const decisionDirectory = path.resolve(
    root,
    ".github/ci-job-classification-decisions",
  );
  const conflicted = new Set<string>();
  // Places one decision under a new supplier. A job the new revision no
  // longer has gets none. Two decisions converging on one job keep the one
  // in place when they agree on the kind; when they disagree both are
  // dropped, so the job is reviewed afresh.
  const place = (key: string, oldFile: string, target: string) => {
    const separator = key.indexOf(":");
    const remainder = key.slice(separator + 1);
    const targetDocuments = retained[target]?.documents ?? {};
    if (
      !Object.keys(targetDocuments).some((file) =>
        remainder.startsWith(`${file}/`),
      )
    ) {
      return;
    }
    const renamedKey = `${target}${key.slice(separator)}`;
    const newFile = path.resolve(root, decisionPathForKey(renamedKey));
    if (conflicted.has(renamedKey)) {
      return;
    }
    if (existsSync(newFile)) {
      if (decisionKind(newFile) !== decisionKind(path.resolve(root, oldFile))) {
        rmSync(newFile);
        conflicted.add(renamedKey);
      }
      return;
    }
    copyFileSync(path.resolve(root, oldFile), newFile);
  };
  for (const name of new Bun.Glob("*.json").scanSync({
    cwd: decisionDirectory,
  })) {
    const oldFile = `.github/ci-job-classification-decisions/${name}`;
    const key = decisionKeyFromPath(oldFile);
    const oldSupplier = key.slice(0, key.indexOf(":"));
    const replacement = replacements.get(oldSupplier);
    for (const target of copies.get(oldSupplier) ?? []) {
      place(key, oldFile, target);
    }
    const kept = retained[oldSupplier];
    const remainder = key.slice(key.indexOf(":") + 1);
    if (replacement) {
      place(key, oldFile, replacement);
      rmSync(path.resolve(root, oldFile));
    } else if (previous[oldSupplier] !== undefined && kept === undefined) {
      rmSync(path.resolve(root, oldFile));
    } else if (
      kept !== undefined &&
      !Object.keys(kept.documents).some((file) =>
        remainder.startsWith(`${file}/`),
      )
    ) {
      // A supplier still in use no longer carries this job's document: its
      // callers moved to another revision (copied above) or dropped it.
      rmSync(path.resolve(root, oldFile));
    }
  }
};

// Pairs each previous supplier with the new ones its callers moved to:
// a removed supplier's decisions move to its successor, and a supplier
// still in use has them copied to the revisions some of its pins moved to.
const pairSuppliers = ({
  previous,
  retained,
  moves,
}: {
  previous: Snapshots;
  retained: Snapshots;
  moves: ReadonlyMap<string, ReadonlySet<string>>;
}) => {
  const replacements = new Map<string, string>();
  const copies = new Map<string, string[]>();
  for (const [oldSupplier, snapshot] of Object.entries(previous)) {
    const { owner, repo } = snapshot.origin;
    const added = Object.entries(retained).filter(
      ([supplier, candidate]) =>
        previous[supplier] === undefined &&
        candidate.origin.owner === owner &&
        candidate.origin.repo === repo,
    );
    const moved = moves.get(sourceIdentity(snapshot.origin));
    if (retained[oldSupplier] !== undefined) {
      // Still pinned elsewhere: only sites that moved off this revision
      // pair it with a new one, whose jobs start from copies of its
      // decisions. Each copy still has to match its job's digest.
      const targets = added
        .filter(([, candidate]) => moved?.has(candidate.origin.sha) === true)
        .map(([supplier]) => supplier);
      if (targets.length > 0) {
        copies.set(oldSupplier, targets);
      }
      continue;
    }
    // Without a caller site that pairs up, only an unambiguous successor
    // inherits the old supplier's decisions.
    const fallback = added.length === 1 ? added[0] : undefined;
    const target =
      moved === undefined
        ? fallback
        : added.find(([, candidate]) => moved.has(candidate.origin.sha));
    if (target !== undefined) {
      replacements.set(oldSupplier, target[0]);
    }
  }
  return { replacements, copies };
};

type SnapshotMergeOptions = {
  root: string;
  previous: Snapshots;
  documents: Map<string, Record<string, string>>;
  origins: Map<string, Snapshot["origin"]>;
};
const mergeSnapshotDocuments = ({
  root,
  previous,
  documents,
  origins,
}: SnapshotMergeOptions) => {
  const retained = Object.fromEntries(
    Object.entries(previous).filter(([, snapshot]) =>
      documents.has(sourceIdentity(snapshot.origin)),
    ),
  );
  for (const identity of [...documents.keys()].toSorted(compareCodeUnit)) {
    const origin = origins.get(identity);
    if (!origin) {
      throw new AdmissionError({ message: "Snapshot origin disappeared" });
    }
    const exact = Object.entries(retained).find(([, snapshot]) =>
      sameMetadataOrigin({ caller: origin, target: snapshot.origin }),
    );
    const supplier =
      exact?.[0] ?? nextSupplierKey(root, { ...previous, ...retained });
    retained[supplier] = {
      origin,
      documents: Object.fromEntries(
        Object.entries(documents.get(identity) ?? {}).toSorted(
          ([left], [right]) => compareCodeUnit(left, right),
        ),
      ),
    };
  }
  return retained;
};

type VisitDocumentOptions = {
  identity: string;
  origin: Snapshot["origin"];
  file: string;
  read: (file: string) => string;
  mount?: string | null;
};

export const writeSnapshots = ({
  root,
  sources,
  base,
}: WriteSnapshotsOptions) => {
  const snapshotFile = path.resolve(
    root,
    ".github/ci-job-classification-sources.json",
  );
  const previous: Snapshots = readClassificationInputs(root).snapshots;
  const configured = Object.fromEntries(
    Object.entries(sources).map(([identity, source]) => [
      identity,
      { provider: createGitProvider({ source }), repository: "source" },
    ]),
  );
  const documents = new Map<string, Record<string, string>>();
  const origins = new Map<string, Snapshot["origin"]>();
  const visited = new Set<string>();
  const mounts = new Map<string, string>();

  const existingFor = (origin: Snapshot["origin"]) =>
    Object.entries(previous).find(([, snapshot]) =>
      sameMetadataOrigin({ caller: origin, target: snapshot.origin }),
    );
  const visitRemote = (reference: string, kind: MetadataReferenceKind) => {
    if (reference.startsWith("docker://")) {
      return;
    }
    const remote = parseRemoteReference(reference);
    const origin = {
      type: "git",
      owner: remote.owner,
      repo: remote.repo,
      sha: remote.sha,
    } as const;
    const identity = sourceIdentity(origin);
    const configuredSource = configured[identity];
    const existing = existingFor(origin);
    if (!configuredSource && !existing) {
      if (kind === "reusable-workflow") {
        throw new AdmissionError({
          message: `Reusable workflow snapshot required: ${reference}`,
        });
      }
      return;
    }
    const read = configuredSource
      ? (file: string) =>
          configuredSource.provider.read(configuredSource.repository, file)
      : (file: string) => {
          const text = existing?.[1].documents[file];
          if (text === undefined) {
            throw new AdmissionError({
              message: `Pinned metadata missing: ${reference}`,
            });
          }
          return text;
        };
    let file: string;
    if (kind === "reusable-workflow") {
      file = remote.path;
    } else {
      try {
        file = actionPath(read, remote.path);
      } catch (error) {
        if (!configuredSource && error instanceof AdmissionError) {
          return;
        }
        throw error;
      }
    }
    visitDocument({ identity, origin, file, read });
  };
  const visitDocument = ({
    identity,
    origin,
    file,
    read,
    mount = null,
  }: VisitDocumentOptions) => {
    const visitKey = `${identity}:${file}`;
    const text = read(file);
    const parsed = parseDocument(text);
    if (parsed.isErr()) {
      throw parsed.error;
    }
    recordMetadataMount({
      mounts,
      identity: visitKey,
      mount,
      document: parsed.value,
    });
    if (visited.has(visitKey)) {
      return;
    }
    visited.add(visitKey);
    origins.set(identity, origin);
    const collected = documents.get(identity) ?? {};
    collected[file] = text;
    documents.set(identity, collected);
    for (const [reference, kind] of Object.entries(parsed.value.dependencies)) {
      if (reference.startsWith("./") || reference.startsWith("$/")) {
        const relative = reference.slice(2);
        const selected = resolveLocalMetadataPath({
          reference,
          kind,
          relocations: parsed.value.relocatedActions[reference] ?? [],
          inheritedMount: mount,
        });
        const sourcePath = selected.path;
        const target =
          kind === "reusable-workflow"
            ? relative
            : actionPath(read, sourcePath);
        visitDocument({
          identity,
          origin,
          file: target,
          read,
          mount: selected.mount,
        });
      } else {
        visitRemote(reference, kind);
      }
    }
  };

  const candidateVisited = new Set<string>();
  const readCandidate = (file: string) =>
    readFileSync(path.resolve(root, file), "utf-8");
  const visitCandidate = (file: string, mount: string | null = null) => {
    const parsed = parseDocument(readCandidate(file));
    if (parsed.isErr()) {
      throw parsed.error;
    }
    recordMetadataMount({
      mounts,
      identity: `candidate:${file}`,
      mount,
      document: parsed.value,
    });
    if (candidateVisited.has(file)) {
      return;
    }
    candidateVisited.add(file);
    for (const [reference, kind] of Object.entries(parsed.value.dependencies)) {
      if (reference.startsWith("./") || reference.startsWith("$/")) {
        const relative = reference.slice(2);
        const selected = resolveLocalMetadataPath({
          reference,
          kind,
          relocations: parsed.value.relocatedActions[reference] ?? [],
          inheritedMount: mount,
        });
        const sourcePath = selected.path;
        const target =
          kind === "reusable-workflow"
            ? relative
            : actionPath(readCandidate, sourcePath);
        visitCandidate(target, selected.mount);
      } else {
        visitRemote(reference, kind);
      }
    }
  };
  for (const file of new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync({
    cwd: root,
  })) {
    visitCandidate(file);
  }

  const retained = mergeSnapshotDocuments({
    root,
    previous,
    documents,
    origins,
  });
  const refreshBase = base ?? gitBase(root);
  const moves = pinMoves(root, refreshBase);
  const { replacements, copies } = pairSuppliers({ previous, retained, moves });
  reconcileDecisions({ root, previous, retained, replacements, copies });
  writeFileSync(snapshotFile, `${JSON.stringify(retained, null, 2)}\n`);

  const refreshed = refreshJobClassificationDigests(root, refreshBase);
  if (refreshed.isErr()) {
    throw refreshed.error;
  }
  return { refreshed: refreshed.value.refreshed };
};

const gitOutput = (root: string, args: readonly string[]) => {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new AdmissionError({ message: `git ${args.join(" ")} failed` });
  }
  return new TextDecoder().decode(result.stdout);
};

const isMetadataFile = (file: string) =>
  file.startsWith(".github/") &&
  (file.endsWith(".yml") || file.endsWith(".yaml"));

/**
 * Each remote `uses:` pin, keyed by its file, its reference without the
 * revision, and its occurrence among equal references in that file, so the
 * same site can be found on both sides of a change.
 */
const pinSites = (files: ReadonlyMap<string, string>) => {
  const sites = new Map<string, { repository: string; sha: string }>();
  for (const [file, text] of files) {
    const occurrences = new Map<string, number>();
    for (const line of text.split("\n")) {
      const at = line.indexOf("uses:");
      if (at === -1) {
        continue;
      }
      const value = line
        .slice(at + "uses:".length)
        .trim()
        .replace(/^["']/u, "")
        .split(/[\s"'#]/u)[0];
      if (!value || value.startsWith("./") || value.startsWith("docker://")) {
        continue;
      }
      const parsed = Result.try(() => parseRemoteReference(value));
      if (parsed.isErr()) {
        continue;
      }
      const { owner, repo, path: documentPath, sha } = parsed.value;
      const reference = `${owner}/${repo}/${documentPath}`;
      const occurrence = occurrences.get(reference) ?? 0;
      occurrences.set(reference, occurrence + 1);
      sites.set(`${file}\0${reference}\0${occurrence}`, {
        repository: `${owner}/${repo}`,
        sha,
      });
    }
  }
  return sites;
};

/** Old `owner/repo@sha` pins mapped to the revisions their sites now pin. */
const pinMoves = (root: string, base: string) => {
  const baseFiles = new Map(
    gitOutput(root, ["ls-tree", "-r", "--name-only", base, "--", ".github"])
      .split("\n")
      .filter(isMetadataFile)
      .map((file) => [file, gitOutput(root, ["show", `${base}:${file}`])]),
  );
  const headFiles = new Map(
    [
      ...new Bun.Glob(".github/**/*.{yml,yaml}").scanSync({
        cwd: root,
        dot: true,
      }),
    ].map((file) => [file, readFileSync(path.resolve(root, file), "utf-8")]),
  );
  const head = pinSites(headFiles);
  const moves = new Map<string, Set<string>>();
  for (const [site, before] of pinSites(baseFiles)) {
    const after = head.get(site);
    if (after === undefined || after.sha === before.sha) {
      continue;
    }
    const key = `${before.repository}@${before.sha}`;
    moves.set(key, (moves.get(key) ?? new Set()).add(after.sha));
  }
  return moves;
};

const gitBase = (root: string) => {
  const result = Bun.spawnSync(
    ["git", "-C", root, "merge-base", "origin/main", "HEAD"],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (result.exitCode !== 0) {
    throw new AdmissionError({
      message: "Cannot determine merge-base of origin/main and HEAD",
    });
  }
  return new TextDecoder().decode(result.stdout).trim();
};

const usage = () =>
  new AdmissionError({
    message:
      "usage: bun scripts/ci-job-classification/snapshots.ts --check | --write [--base <sha>] --source <owner>/<repo>@<sha>=<checkout-dir> [...]",
  });

const parseSources = (args: string[]) => {
  const sources: Record<string, Source> = {};
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] !== "--source" || args[index + 1] === undefined) {
      throw usage();
    }
    const value = args[index + 1] ?? "";
    const equals = value.indexOf("=");
    const reference = value.slice(0, equals);
    const remote = parseRemoteReference(reference);
    if (equals === -1 || remote.path !== "") {
      throw usage();
    }
    sources[`${remote.owner}/${remote.repo}@${remote.sha}`] = {
      directory: value.slice(equals + 1),
      revision: remote.sha,
    };
  }
  return sources;
};

const run = () => {
  const [mode, ...args] = Bun.argv.slice(2);
  if (mode === "--check" && args.length === 0) {
    const process = Bun.spawnSync(
      ["bun", "scripts/check-ci-job-classification.ts", "--check"],
      {
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    return process.exitCode;
  }
  if (mode !== "--write") {
    throw usage();
  }
  const base = args[0] === "--base" ? args[1] : undefined;
  if (args[0] === "--base" && !/^[0-9a-f]{40}$/u.test(base ?? "")) {
    throw usage();
  }
  writeSnapshots({
    root: ".",
    sources: parseSources(base === undefined ? args : args.slice(2)),
    ...(base === undefined ? {} : { base }),
  });
  return 0;
};

if (import.meta.main) {
  const result = Result.try({
    try: run,
    catch: (cause) =>
      cause instanceof AdmissionError
        ? cause
        : new AdmissionError({
            message:
              cause instanceof Error
                ? cause.message
                : "Snapshot generation failed",
          }),
  });
  if (result.isErr()) {
    process.stderr.write(`${result.error.message}\n`);
    process.exit(1);
  }
  process.exit(result.value);
}

import { Result } from "better-result";
import {
  existsSync,
  readFileSync,
  renameSync,
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
import { parseRemoteReference, sameMetadataOrigin } from "./references";
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
  replacements: ReadonlyMap<string, string>;
};

const reconcileDecisions = ({
  root,
  previous,
  retained,
  replacements,
}: ReconcileDecisionsOptions) => {
  const decisionDirectory = path.resolve(
    root,
    ".github/ci-job-classification-decisions",
  );
  for (const name of new Bun.Glob("*.json").scanSync({
    cwd: decisionDirectory,
  })) {
    const oldFile = `.github/ci-job-classification-decisions/${name}`;
    const key = decisionKeyFromPath(oldFile);
    const separator = key.indexOf(":");
    const oldSupplier = key.slice(0, separator);
    const replacement = replacements.get(oldSupplier);
    if (!replacement) {
      if (
        previous[oldSupplier] !== undefined &&
        retained[oldSupplier] === undefined
      ) {
        rmSync(path.resolve(root, oldFile));
      }
      continue;
    }
    const remainder = key.slice(separator + 1);
    const replacementDocuments = retained[replacement]?.documents ?? {};
    if (
      !Object.keys(replacementDocuments).some((file) =>
        remainder.startsWith(`${file}/`),
      )
    ) {
      rmSync(path.resolve(root, oldFile));
      continue;
    }
    const renamedKey = `${replacement}${key.slice(separator)}`;
    const newFile = path.resolve(root, decisionPathForKey(renamedKey));
    if (existsSync(newFile)) {
      throw new AdmissionError({
        message: `Decision already exists: ${renamedKey}`,
      });
    }
    renameSync(path.resolve(root, oldFile), newFile);
  }
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
    visitDocument(identity, origin, file, read);
  };
  const visitDocument = (
    identity: string,
    origin: Snapshot["origin"],
    file: string,
    read: (file: string) => string,
  ) => {
    const visitKey = `${identity}:${file}`;
    if (visited.has(visitKey)) {
      return;
    }
    visited.add(visitKey);
    const text = read(file);
    const parsed = parseDocument(text);
    if (parsed.isErr()) {
      throw parsed.error;
    }
    origins.set(identity, origin);
    const collected = documents.get(identity) ?? {};
    collected[file] = text;
    documents.set(identity, collected);
    for (const [reference, kind] of Object.entries(parsed.value.dependencies)) {
      if (reference.startsWith("./") || reference.startsWith("$/")) {
        const relative = reference.slice(2);
        const sourcePath =
          parsed.value.relocatedActions[reference]?.at(0)?.path ?? relative;
        const target =
          kind === "reusable-workflow"
            ? relative
            : actionPath(read, sourcePath);
        visitDocument(identity, origin, target, read);
      } else {
        visitRemote(reference, kind);
      }
    }
  };

  const candidateVisited = new Set<string>();
  const readCandidate = (file: string) =>
    readFileSync(path.resolve(root, file), "utf-8");
  const visitCandidate = (file: string) => {
    if (candidateVisited.has(file)) {
      return;
    }
    candidateVisited.add(file);
    const parsed = parseDocument(readCandidate(file));
    if (parsed.isErr()) {
      throw parsed.error;
    }
    for (const [reference, kind] of Object.entries(parsed.value.dependencies)) {
      if (reference.startsWith("./") || reference.startsWith("$/")) {
        const relative = reference.slice(2);
        const sourcePath =
          parsed.value.relocatedActions[reference]?.at(0)?.path ?? relative;
        const target =
          kind === "reusable-workflow"
            ? relative
            : actionPath(readCandidate, sourcePath);
        visitCandidate(target);
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

  const retained = Object.fromEntries(
    Object.entries(previous).filter(([, snapshot]) =>
      documents.has(sourceIdentity(snapshot.origin)),
    ),
  );
  const replacements = new Map<string, string>();
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
    for (const [oldSupplier, snapshot] of Object.entries(previous)) {
      if (
        oldSupplier !== supplier &&
        retained[oldSupplier] === undefined &&
        snapshot.origin.owner === origin.owner &&
        snapshot.origin.repo === origin.repo
      ) {
        replacements.set(oldSupplier, supplier);
      }
    }
  }

  reconcileDecisions({ root, previous, retained, replacements });
  writeFileSync(snapshotFile, `${JSON.stringify(retained, null, 2)}\n`);

  const refreshBase = base ?? gitBase(root);
  const refreshed = refreshJobClassificationDigests(root, refreshBase);
  if (refreshed.isErr()) {
    throw refreshed.error;
  }
  return { refreshed: refreshed.value.refreshed };
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
      "usage: bun scripts/ci-job-classification/snapshots.ts --check | --write --source <owner>/<repo>@<sha>=<checkout-dir> [...]",
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
  writeSnapshots({ root: ".", sources: parseSources(args) });
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

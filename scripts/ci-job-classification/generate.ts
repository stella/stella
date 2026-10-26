import { Result } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { compareCodeUnit } from "../../packages/collation/src/collation";
import { CLASSIFICATIONS, sha256 } from "./classification-values";
import { readDecisions } from "./decisions";
import { decisionPathForKey } from "./inputs";
import { verifyPublicMetadata } from "./public-metadata";
import type { MetadataReader, PublicMetadata } from "./public-metadata";
import {
  GIT_ORIGIN,
  parseRemoteReference,
  sameMetadataOrigin,
} from "./references";
import type { MetadataOrigin, MetadataReferenceKind } from "./references";
import { isPrivilegedJobClosure, ReviewRequiredError } from "./review";
import { AdmissionError, parseDocument } from "./yaml";
import type { ParsedDocument } from "./yaml";

const DECISIONS = v.record(
  v.string(),
  v.strictObject({
    kind: v.picklist(CLASSIFICATIONS),
    qualifier: v.pipe(v.string(), v.minLength(1)),
    reviewedDigest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)),
  }),
);
const REVISION_DECISIONS = v.record(
  v.string(),
  v.strictObject({
    kind: v.picklist(CLASSIFICATIONS),
    qualifier: v.pipe(v.string(), v.minLength(1)),
    reviewedDigest: v.optional(v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u))),
  }),
);
const SNAPSHOTS = v.record(
  v.string(),
  v.strictObject({
    origin: GIT_ORIGIN,
    documents: v.record(v.string(), v.string()),
  }),
);
export const readClassificationInputs = (root: string) => {
  const read = (file: string): unknown =>
    JSON.parse(readFileSync(path.resolve(root, ".github", file), "utf-8"));
  const snapshots = v.parse(
    SNAPSHOTS,
    read("ci-job-classification-sources.json"),
  );
  const reader: MetadataReader = {
    workflows: () =>
      [
        ...new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync({
          cwd: root,
        }),
      ].toSorted(),
    read: (repository, file) => {
      if (repository === "candidate") {
        if (
          path.isAbsolute(file) ||
          file.split("/").some((part) => part === "..")
        ) {
          throw new AdmissionError({ message: "unsafe metadata path" });
        }
        return readFileSync(path.resolve(root, file), "utf-8");
      }
      const text = snapshots[repository]?.documents[file];
      if (text === undefined) {
        throw new AdmissionError({
          message: `Pinned metadata missing: ${repository}:${file}`,
        });
      }
      return text;
    },
  };
  return {
    decisions: v.parse(
      DECISIONS,
      readDecisions({ type: "working-tree", root }),
    ),
    snapshots,
    reader,
    localActionPath: (directory: string) => {
      const file = ["action.yml", "action.yaml"]
        .map((name) => `${directory}/${name}`)
        .find((candidatePath) => existsSync(path.resolve(root, candidatePath)));
      if (!file) {
        throw new AdmissionError({
          message: `Local action metadata missing: ${directory}`,
        });
      }
      return file;
    },
  };
};

const gitText = (root: string, args: string[]) => {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new AdmissionError({
      message:
        new TextDecoder().decode(result.stderr).trim() ||
        `git ${args.join(" ")} failed`,
    });
  }
  return new TextDecoder().decode(result.stdout);
};

export const readClassificationInputsAtRevision = (
  root: string,
  revision: string,
) => {
  const readCandidate = (file: string) =>
    gitText(root, ["show", `${revision}:${file}`]);
  const readGithubJson = (file: string): unknown =>
    JSON.parse(readCandidate(`.github/${file}`));
  const snapshots = v.parse(
    SNAPSHOTS,
    readGithubJson("ci-job-classification-sources.json"),
  );
  const reader: MetadataReader = {
    workflows: () =>
      gitText(root, [
        "ls-tree",
        "-r",
        "--name-only",
        revision,
        "--",
        ".github/workflows",
      ])
        .split("\n")
        .filter((file) => /^\.github\/workflows\/.*\.ya?ml$/u.test(file))
        .toSorted(),
    read: (repository, file) => {
      if (repository === "candidate") {
        if (
          path.isAbsolute(file) ||
          file.split("/").some((part) => part === "..")
        ) {
          throw new AdmissionError({ message: "unsafe metadata path" });
        }
        return readCandidate(file);
      }
      const text = snapshots[repository]?.documents[file];
      if (text === undefined) {
        throw new AdmissionError({
          message: `Pinned metadata missing: ${repository}:${file}`,
        });
      }
      return text;
    },
  };
  const revisionDecisions = v.parse(
    REVISION_DECISIONS,
    readDecisions({ type: "git-revision", root, revision }),
  );
  return {
    decisions: v.parse(
      DECISIONS,
      Object.fromEntries(
        Object.entries(revisionDecisions).map(([key, decision]) => [
          key,
          {
            ...decision,
            reviewedDigest: decision.reviewedDigest ?? "0".repeat(64),
          },
        ]),
      ),
    ),
    snapshots,
    reader,
    localActionPath: (directory: string) => {
      const file = ["action.yml", "action.yaml"]
        .map((name) => `${directory}/${name}`)
        .find((candidatePath) => {
          const result = Bun.spawnSync(
            [
              "git",
              "-C",
              root,
              "cat-file",
              "-e",
              `${revision}:${candidatePath}`,
            ],
            { stdout: "ignore", stderr: "ignore" },
          );
          return result.exitCode === 0;
        });
      if (!file) {
        throw new AdmissionError({
          message: `Local action metadata missing: ${directory}`,
        });
      }
      return file;
    },
  };
};

type RemoteSourceOptions = {
  reference: string;
  kind: MetadataReferenceKind;
  snapshots: v.InferOutput<typeof SNAPSHOTS>;
};
const findRemoteSource = ({
  reference,
  kind,
  snapshots,
}: RemoteSourceOptions) => {
  if (reference.startsWith("docker://")) {
    return undefined;
  }
  const remote = parseRemoteReference(reference);
  const snapshot = Object.entries(snapshots).find(([, entry]) =>
    sameMetadataOrigin({
      caller: {
        type: "git",
        owner: remote.owner,
        repo: remote.repo,
        sha: remote.sha,
      },
      target: entry.origin,
    }),
  );
  if (!snapshot) {
    return undefined;
  }
  const file =
    kind === "reusable-workflow"
      ? remote.path
      : ["action.yml", "action.yaml"]
          .map((name) => (remote.path ? `${remote.path}/${name}` : name))
          .find(
            (candidatePath) =>
              snapshot[1].documents[candidatePath] !== undefined,
          );
  if (!file || snapshot[1].documents[file] === undefined) {
    return undefined;
  }
  return { repository: snapshot[0], file, origin: snapshot[1].origin };
};

type MetadataNodes = Map<string, PublicMetadata["nodes"][number]>;
type DocumentDigestOptions = {
  nodes: MetadataNodes;
  parsedDocuments: ReadonlyMap<string, ParsedDocument>;
};
// A document digest binds its own shape and every metadata document it
// reaches, so editing a callee changes the digest of each caller.
const createDocumentDigest = ({
  nodes,
  parsedDocuments,
}: DocumentDigestOptions) => {
  const documentDigests = new Map<string, string>();
  const activeDigests = new Set<string>();
  const documentDigest = (id: string): string => {
    const cached = documentDigests.get(id);
    if (cached) {
      return cached;
    }
    if (activeDigests.has(id)) {
      throw new AdmissionError({ message: "metadata dependency cycle" });
    }
    const node = nodes.get(id);
    const parsed = parsedDocuments.get(id);
    if (!node || node.type !== "metadata" || !parsed) {
      return id;
    }
    activeDigests.add(id);
    const dependencies = Object.fromEntries(
      Object.entries(node.edges)
        .filter(([, target]) => nodes.get(target)?.type === "metadata")
        .toSorted(([left], [right]) => compareCodeUnit(left, right))
        .map(([reference, target]) => [reference, documentDigest(target)]),
    );
    activeDigests.delete(id);
    const digest = Object.keys(dependencies).length
      ? sha256(JSON.stringify({ digest: parsed.digest, dependencies }))
      : parsed.digest;
    documentDigests.set(id, digest);
    return digest;
  };
  return documentDigest;
};

export type DerivedJob = { digest: string; privileged: boolean };
type ReviewJobsOptions = DocumentDigestOptions & {
  decisions: v.InferOutput<typeof DECISIONS>;
  documentDigest: (id: string) => string;
  observeJobs?: (jobs: ReadonlyMap<string, DerivedJob>) => void;
};
type ReachableDocumentsOptions = DocumentDigestOptions & {
  initialTargets: string[];
};
const reachableDocuments = ({
  initialTargets,
  nodes,
  parsedDocuments,
}: ReachableDocumentsOptions) => {
  const documents: ParsedDocument[] = [];
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) {
      return;
    }
    visited.add(id);
    const node = nodes.get(id);
    const parsed = parsedDocuments.get(id);
    if (!node || node.type !== "metadata" || !parsed) {
      return;
    }
    documents.push(parsed);
    for (const target of Object.values(node.edges)) {
      visit(target);
    }
  };
  for (const target of initialTargets) {
    visit(target);
  }
  return documents;
};
const reviewJobs = ({
  nodes,
  parsedDocuments,
  decisions,
  documentDigest,
  observeJobs,
}: ReviewJobsOptions) => {
  const entries: Record<string, unknown> = {};
  const privilegedJobs: string[] = [];
  const observedJobs = new Set<string>();
  const derivedJobs = new Map<string, DerivedJob>();
  for (const node of nodes.values()) {
    if (node.type !== "metadata") {
      continue;
    }
    const parsed = parsedDocuments.get(node.id);
    if (!parsed) {
      throw new AdmissionError({ message: "parsed metadata missing" });
    }
    node.jobs = Object.entries(parsed.jobs).flatMap(([jobId, job]) => {
      const key = `${node.repository}:${node.path}/${jobId}`;
      observedJobs.add(key);
      const dependencyDigests = Object.fromEntries(
        Object.keys(job.dependencies)
          .toSorted(compareCodeUnit)
          .flatMap((reference) => {
            const target = node.edges[reference];
            return target && nodes.get(target)?.type === "metadata"
              ? [[reference, documentDigest(target)]]
              : [];
          }),
      );
      const digest = Object.keys(dependencyDigests).length
        ? sha256(
            JSON.stringify({
              digest: job.digest,
              dependencies: dependencyDigests,
            }),
          )
        : job.digest;
      const decision = decisions[key];
      const targets = Object.keys(job.dependencies).flatMap((reference) => {
        const target = node.edges[reference];
        return target ? [target] : [];
      });
      const privileged = isPrivilegedJobClosure({
        kind: decision?.kind,
        shape: job.shape,
        reachableDocuments: reachableDocuments({
          initialTargets: targets,
          nodes,
          parsedDocuments,
        }),
      });
      derivedJobs.set(key, { digest, privileged });
      if (!decision || decision.reviewedDigest !== digest) {
        entries[key] = {
          kind: decision?.kind ?? "<choose ordinary, support, or priority>",
          qualifier:
            decision?.qualifier ?? "<describe the reviewed classification>",
          reviewedDigest: digest,
        };
        if (privileged) {
          privilegedJobs.push(key);
        }
      }
      return decision
        ? [
            {
              id: jobId,
              kind: decision.kind,
              qualifier: decision.qualifier,
              digest,
            },
          ]
        : [];
    });
  }
  observeJobs?.(derivedJobs);
  const removed = Object.keys(decisions).filter(
    (key) => !observedJobs.has(key),
  );
  if (removed.length) {
    throw new AdmissionError({
      message: `Decisions for removed jobs: ${removed.join(", ")}. Remove these files:\n${removed.map(decisionPathForKey).join("\n")}`,
    });
  }
  if (Object.keys(entries).length) {
    throw new ReviewRequiredError({
      message: `${privilegedJobs.length ? `Sensitive classification change: ${privilegedJobs.join(", ")}\n` : ""}Missing or changed job review. Re-review kind and qualifier, then create or update each listed file (choose kind and qualifier for new jobs):\n${Object.entries(
        entries,
      )
        .map(
          ([key, value]) =>
            `${decisionPathForKey(key)}\n${JSON.stringify(value, null, 2)}`,
        )
        .join("\n")}`,
      privilegedJobs,
    });
  }
};

type GenerateOptions = {
  decisions: v.InferOutput<typeof DECISIONS>;
  snapshots: v.InferOutput<typeof SNAPSHOTS>;
  reader: MetadataReader;
  localActionPath: (directory: string) => string;
  observeJobs?: (jobs: ReadonlyMap<string, DerivedJob>) => void;
};
export const generateClassification = ({
  decisions,
  snapshots,
  reader,
  localActionPath,
  observeJobs,
}: GenerateOptions) =>
  Result.try({
    try: () => {
      const nodes: MetadataNodes = new Map();
      const parsedDocuments = new Map<string, ParsedDocument>();
      type VisitOptions = {
        repository: string;
        file: string;
        origin: MetadataOrigin;
      };
      const visit = ({ repository, file, origin }: VisitOptions): string => {
        const id = `source-${sha256(`${repository}:${file}`)}`;
        if (nodes.has(id)) {
          return id;
        }
        const parsed = parseDocument(reader.read(repository, file));
        if (parsed.isErr()) {
          throw parsed.error;
        }
        const references: string[] = [];
        const edges: Record<string, string> = {};
        parsedDocuments.set(id, parsed.value);
        const node = {
          type: "metadata",
          id,
          repository,
          origin,
          path: file,
          digest: parsed.value.digest,
          references,
          edges,
          jobs: [],
        } satisfies PublicMetadata["nodes"][number];
        // Register before recursion; the verifier reports dependency cycles.
        nodes.set(id, node);
        for (const [reference, kind] of Object.entries(
          parsed.value.dependencies,
        ).toSorted(([left], [right]) => compareCodeUnit(left, right))) {
          let targetId: string;
          if (reference.startsWith("$/") || reference.startsWith("./")) {
            const relative = reference.slice(2);
            const relocation = parsed.value.relocatedActions[reference]?.at(0);
            const sourcePath = relocation?.path ?? relative;
            let targetPath: string;
            if (kind === "reusable-workflow") {
              targetPath = relative;
            } else if (repository === "candidate") {
              targetPath = localActionPath(sourcePath);
            } else {
              const documents = snapshots[repository]?.documents;
              const found = ["action.yml", "action.yaml"]
                .map((name) => `${sourcePath}/${name}`)
                .find(
                  (candidatePath) => documents?.[candidatePath] !== undefined,
                );
              if (!found) {
                throw new AdmissionError({
                  message: `Local action metadata missing: ${repository}:${sourcePath}`,
                });
              }
              targetPath = found;
            }
            targetId = visit({ repository, file: targetPath, origin });
          } else {
            const source = findRemoteSource({ reference, kind, snapshots });
            if (source) {
              targetId = visit(source);
            } else {
              if (kind === "reusable-workflow") {
                throw new AdmissionError({
                  message: `Reusable workflow snapshot required: ${reference}`,
                });
              }
              targetId = `supplier-${sha256(reference)}`;
              nodes.set(targetId, {
                type: "supplier",
                id: targetId,
                reference,
                binding: "immutable",
              });
            }
          }
          node.edges[reference] = targetId;
          const target = nodes.get(targetId);
          if (
            target?.type === "metadata" &&
            !target.references.includes(reference)
          ) {
            target.references.push(reference);
          }
        }
        return id;
      };
      const workflows = reader
        .workflows()
        .toSorted()
        .map((file) => ({
          path: file,
          node: visit({
            repository: "candidate",
            file,
            origin: { type: "checkout" },
          }),
        }));
      const documentDigest = createDocumentDigest({ nodes, parsedDocuments });
      reviewJobs({
        nodes,
        parsedDocuments,
        decisions,
        documentDigest,
        ...(observeJobs ? { observeJobs } : {}),
      });
      const generated = {
        version: 1,
        mode: "public-metadata",
        repository: "candidate",
        workflows,
        nodes: [...nodes.values()]
          .map((node) =>
            node.type === "metadata"
              ? { ...node, references: node.references.toSorted() }
              : node,
          )
          .toSorted((a, b) => compareCodeUnit(a.id, b.id)),
      } as const satisfies PublicMetadata;
      const checked = verifyPublicMetadata({ manifest: generated, reader });
      if (checked.isErr()) {
        throw checked.error;
      }
      return generated;
    },
    catch: (cause) =>
      cause instanceof ReviewRequiredError
        ? cause
        : new AdmissionError({
            message:
              cause instanceof Error
                ? cause.message
                : "Classification derivation failed",
          }),
  });

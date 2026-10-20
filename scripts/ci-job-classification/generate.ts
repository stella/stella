import { Result } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { compareCodeUnit } from "../../packages/collation/src/collation";
import { CLASSIFICATIONS, sha256 } from "./classification-values";
import { verifyPublicMetadata } from "./public-metadata";
import type { PublicMetadata, MetadataReader } from "./public-metadata";
import {
  GIT_ORIGIN,
  parseRemoteReference,
  sameMetadataOrigin,
} from "./references";
import type { MetadataOrigin, MetadataReferenceKind } from "./references";
import { isPrivilegedJob, ReviewRequiredError } from "./review";
import { AdmissionError, parseDocument } from "./yaml";

const DECISIONS = v.record(
  v.string(),
  v.strictObject({
    kind: v.picklist(CLASSIFICATIONS),
    qualifier: v.pipe(v.string(), v.minLength(1)),
    reviewedDigest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)),
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
    decisions: v.parse(DECISIONS, read("ci-job-classification-decisions.json")),
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

type GenerateOptions = {
  decisions: v.InferOutput<typeof DECISIONS>;
  snapshots: v.InferOutput<typeof SNAPSHOTS>;
  reader: MetadataReader;
  localActionPath: (directory: string) => string;
};
export const generateClassification = ({
  decisions,
  snapshots,
  reader,
  localActionPath,
}: GenerateOptions) =>
  Result.try({
    try: () => {
      const nodes = new Map<string, PublicMetadata["nodes"][number]>();
      const entries: Record<string, unknown> = {};
      const privilegedJobs: string[] = [];
      const observedJobs = new Set<string>();
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
        const node = {
          type: "metadata",
          id,
          repository,
          origin,
          path: file,
          digest: parsed.value.digest,
          references,
          edges,
          jobs: Object.entries(parsed.value.jobs).flatMap(([jobId, job]) => {
            const key = `${repository}:${file}/${jobId}`;
            observedJobs.add(key);
            const decision = decisions[key];
            if (!decision || decision.reviewedDigest !== job.digest) {
              entries[key] = {
                kind:
                  decision?.kind ?? "<choose ordinary, support, or priority>",
                qualifier:
                  decision?.qualifier ??
                  "<describe the reviewed classification>",
                reviewedDigest: job.digest,
              };
              if (isPrivilegedJob({ kind: decision?.kind, shape: job.shape })) {
                privilegedJobs.push(key);
              }
            }
            return decision
              ? [
                  {
                    id: jobId,
                    kind: decision.kind,
                    qualifier: decision.qualifier,
                    digest: job.digest,
                  },
                ]
              : [];
          }),
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
      const removed = Object.keys(decisions).filter(
        (key) => !observedJobs.has(key),
      );
      if (removed.length) {
        throw new AdmissionError({
          message: `Decisions for removed jobs: ${removed.join(", ")}. Remove these entries from .github/ci-job-classification-decisions.json`,
        });
      }
      if (Object.keys(entries).length) {
        throw new ReviewRequiredError({
          message: `${privilegedJobs.length ? `Sensitive classification change: ${privilegedJobs.join(", ")}\n` : ""}Missing or changed job review. Re-review kind and qualifier; paste these entries into .github/ci-job-classification-decisions.json (choose kind and qualifier for new jobs):\n${JSON.stringify(entries, null, 2)}`,
          privilegedJobs,
        });
      }
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

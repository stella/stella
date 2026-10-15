import { Result } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { compareCodeUnit } from "../../packages/collation/src/collation";
import { CLASSIFICATIONS, sha256 } from "./classification-values";
import {
  PUBLIC_METADATA,
  REFRESH_COMMAND,
  verifyPublicMetadata,
} from "./public-metadata";
import type { PublicMetadata, MetadataReader } from "./public-metadata";
import { GIT_ORIGIN } from "./references";
import { AdmissionError, parseDocument } from "./yaml";

const DECISIONS = v.record(
  v.string(),
  v.strictObject({
    kind: v.picklist(CLASSIFICATIONS),
    qualifier: v.pipe(v.string(), v.minLength(1)),
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
    manifest: v.parse(PUBLIC_METADATA, read("ci-job-classification.json")),
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

type GenerateOptions = {
  manifest: PublicMetadata;
  decisions: v.InferOutput<typeof DECISIONS>;
  reader: MetadataReader;
  localActionPath: (directory: string) => string;
};
// Every emitted field except kind/qualifier is derived from the reachable tree.
export const generateClassification = ({
  manifest,
  decisions,
  reader,
  localActionPath,
}: GenerateOptions) =>
  Result.try({
    try: () => {
      const nodes = new Map<string, PublicMetadata["nodes"][number]>();
      const missing: string[] = [];
      const source = (repository: string, file: string) =>
        manifest.nodes.find(
          (node) =>
            node.type === "metadata" &&
            node.repository === repository &&
            node.path === file,
        );
      const visit = (original: PublicMetadata["nodes"][number]): string => {
        if (nodes.has(original.id)) {
          return original.id;
        }
        if (original.type === "supplier") {
          nodes.set(original.id, original);
          return original.id;
        }
        const parsed = parseDocument(
          reader.read(original.repository, original.path),
        );
        if (parsed.isErr()) {
          throw parsed.error;
        }
        const edges: Record<string, string> = {};
        const references: string[] = [];
        const node = {
          ...original,
          digest: parsed.value.digest,
          references,
          edges,
          jobs: Object.entries(parsed.value.jobs).flatMap(([id, job]) => {
            const key = `${original.repository}:${original.path}/${id}`;
            const decision = decisions[key];
            if (!decision) {
              missing.push(key);
              return [];
            }
            return [{ id, ...decision, digest: job.digest }];
          }),
        } satisfies PublicMetadata["nodes"][number];
        nodes.set(node.id, node);
        for (const [reference, kind] of Object.entries(
          parsed.value.dependencies,
        ).toSorted(([left], [right]) => compareCodeUnit(left, right))) {
          let target = manifest.nodes.find((entry) =>
            entry.type === "supplier"
              ? entry.reference === reference
              : entry.references.includes(reference),
          );
          if (
            reference.startsWith("$/") ||
            (reference.startsWith("./") && !target)
          ) {
            const relative = reference.slice(2);
            const file = /\.ya?ml$/u.test(relative)
              ? relative
              : localActionPath(relative);
            target = source(node.repository, file) ?? {
              type: "metadata",
              id: `source-${sha256(`${node.repository}:${file}`)}`,
              repository: node.repository,
              origin: node.origin,
              path: file,
              digest: "0".repeat(64),
              references: [],
              jobs: [],
              edges: {},
            };
          }
          if (!target) {
            if (kind === "reusable-workflow") {
              throw new AdmissionError({
                message: `Reusable workflow snapshot required: ${reference}`,
              });
            }
            target = {
              type: "supplier",
              id: `supplier-${sha256(reference)}`,
              reference,
              binding: "immutable",
            };
          }
          node.edges[reference] = visit(target);
          const emitted = nodes.get(target.id);
          if (
            emitted?.type === "metadata" &&
            !emitted.references.includes(reference)
          ) {
            emitted.references.push(reference);
          }
        }
        return node.id;
      };
      const workflows = reader
        .workflows()
        .toSorted()
        .map((file) => {
          const original =
            source(manifest.repository, file) ??
            ({
              type: "metadata",
              id: `source-${sha256(`${manifest.repository}:${file}`)}`,
              repository: manifest.repository,
              origin: { type: "checkout" },
              path: file,
              digest: "0".repeat(64),
              references: [],
              jobs: [],
              edges: {},
            } satisfies PublicMetadata["nodes"][number]);
          return { path: file, node: visit(original) };
        });
      if (missing.length) {
        throw new AdmissionError({
          message: `Unclassified jobs: ${missing.join(", ")}. Add kind and qualifier to .github/ci-job-classification-decisions.json, then run ${REFRESH_COMMAND}`,
        });
      }
      const generated = {
        version: manifest.version,
        mode: manifest.mode,
        repository: manifest.repository,
        workflows,
        nodes: [...nodes.values()]
          .map((node) =>
            node.type === "metadata"
              ? { ...node, references: node.references.toSorted() }
              : node,
          )
          .toSorted((a, b) => compareCodeUnit(a.id, b.id)),
      };
      const checked = verifyPublicMetadata({ manifest: generated, reader });
      if (checked.isErr()) {
        throw checked.error;
      }
      return generated;
    },
    catch: (cause) =>
      new AdmissionError({
        message:
          cause instanceof Error
            ? cause.message
            : "Classification generation failed",
      }),
  });

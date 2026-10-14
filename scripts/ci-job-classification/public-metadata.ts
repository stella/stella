import { Result } from "better-result";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import { CLASSIFICATIONS, sha256 } from "./classification-values";
import {
  createGitProvider,
  resolveGitHead,
  SOURCE_CONFIG,
} from "./git-provider";
import { AdmissionError, parseDocument } from "./yaml";

const TEXT = v.pipe(
  v.string(),
  v.minLength(1),
  v.check((text) => text.trim().length > 0, "Expected nonblank metadata text"),
);
const DIGEST = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u));
const JOB = v.strictObject({
  id: TEXT,
  kind: v.picklist(CLASSIFICATIONS),
  qualifier: TEXT,
  digest: DIGEST,
});
const SOURCE = v.strictObject({
  type: v.literal("metadata"),
  id: TEXT,
  repository: TEXT,
  path: TEXT,
  digest: DIGEST,
  references: v.array(TEXT),
  jobs: v.array(JOB),
  edges: v.record(TEXT, TEXT),
});
const SUPPLIER = v.strictObject({
  type: v.literal("supplier"),
  id: TEXT,
  reference: TEXT,
  binding: v.picklist(["immutable", "caller-bound"]),
});
// This schema cannot represent execution trees or shell capability contracts.
export const PUBLIC_METADATA = v.strictObject({
  version: v.literal(1),
  mode: v.literal("public-metadata"),
  repository: TEXT,
  workflows: v.array(v.strictObject({ path: TEXT, node: TEXT })),
  nodes: v.array(v.variant("type", [SOURCE, SUPPLIER])),
});
export type PublicMetadata = v.InferOutput<typeof PUBLIC_METADATA>;
export type MetadataReader = {
  workflows: () => string[];
  read: (repository: string, path: string) => string;
};
const reject = (message: string): never => {
  throw new AdmissionError({ message });
};
const unique = (items: string[], name: string) => {
  if (new Set(items).size !== items.length) {
    reject(`duplicate ${name}`);
  }
};
const safePath = (path: string) => {
  if (
    path.startsWith("/") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    reject("unsafe metadata path");
  }
};
type MetadataReferenceKind = "reusable-workflow" | "action";
type RemoteMetadataPathOptions = {
  reference: string;
  targetPath: string;
  kind: MetadataReferenceKind;
};
const matchesRemoteMetadataPath = ({
  reference,
  targetPath,
  kind,
}: RemoteMetadataPathOptions) => {
  const revision = reference.lastIndexOf("@");
  const parts = reference.slice(0, revision).split("/");
  if (
    revision <= 0 ||
    revision === reference.length - 1 ||
    parts.length < 2 ||
    parts.some((part) => part.length === 0)
  ) {
    reject("invalid remote metadata reference");
  }
  const remotePath = parts.slice(2).join("/");
  if (remotePath) {
    safePath(remotePath);
  }
  const directory = remotePath ? `${remotePath}/` : "";
  return kind === "reusable-workflow"
    ? targetPath === remotePath
    : targetPath === `${directory}action.yml` ||
        targetPath === `${directory}action.yaml`;
};
type ReferenceOptions = {
  callerRepository: string;
  target: PublicMetadata["nodes"][number];
  reference: string;
  kind: MetadataReferenceKind;
};
const verifyReference = ({
  callerRepository,
  target,
  reference,
  kind,
}: ReferenceOptions) => {
  if (
    kind === "reusable-workflow" &&
    (target.type !== "metadata" || target.jobs.length === 0)
  ) {
    reject("reusable workflow requires callee job metadata");
  }
  if (target.type === "metadata") {
    if (
      kind === "reusable-workflow" &&
      (reference.startsWith("./") || reference.startsWith("$/")) &&
      (target.repository !== callerRepository ||
        target.path !== reference.slice(2))
    ) {
      reject("local reusable workflow metadata path or repository mismatch");
    }
    if (
      !reference.startsWith("./") &&
      !reference.startsWith("$/") &&
      !matchesRemoteMetadataPath({ reference, targetPath: target.path, kind })
    ) {
      reject("remote metadata path mismatch");
    }
    if (reference.startsWith("$/")) {
      const local = reference.slice(2);
      const exactPath = /\.ya?ml$/u.test(local)
        ? target.path === local
        : target.path === `${local}/action.yml` ||
          target.path === `${local}/action.yaml`;
      if (target.repository !== callerRepository || !exactPath) {
        reject("source-relative metadata path mismatch");
      }
    }
    if (!target.references.includes(reference)) {
      reject("callee metadata reference mismatch");
    }
  } else {
    if (reference.startsWith("$/") || reference.startsWith("./")) {
      reject("local action requires metadata source");
    }
    if (reference !== target.reference) {
      reject("supplier reference mismatch");
    }
    if (
      target.binding === "immutable" &&
      !/@[0-9a-f]{40}$/u.test(reference) &&
      !/^docker:\/\/[^\s]+@sha256:[0-9a-f]{64}$/u.test(reference)
    ) {
      reject("mutable supplier marked immutable");
    }
  }
};

export type MetadataOptions = { manifest: unknown; reader: MetadataReader };
export const verifyPublicMetadata = ({ manifest, reader }: MetadataOptions) =>
  Result.try({
    try: () => {
      const metadata = v.parse(PUBLIC_METADATA, manifest);
      unique(
        metadata.nodes.map((node) => node.id),
        "metadata node",
      );
      unique(
        metadata.workflows.map((workflow) => workflow.path),
        "workflow declaration",
      );
      const observed = reader.workflows().toSorted();
      unique(observed, "observed workflow");
      if (
        JSON.stringify(observed) !==
        JSON.stringify(
          metadata.workflows.map((workflow) => workflow.path).toSorted(),
        )
      ) {
        reject("workflow classification totality mismatch");
      }
      const nodes = new Map(metadata.nodes.map((node) => [node.id, node]));
      const visited = new Set<string>();
      const active = new Set<string>();
      const classifications = { ordinary: 0, support: 0, priority: 0 };
      let jobCount = 0;
      let documentCount = 0;
      const visit = (id: string): void => {
        if (active.has(id)) {
          reject("metadata dependency cycle");
        }
        if (visited.has(id)) {
          return;
        }
        const node = nodes.get(id);
        if (!node) {
          reject(`missing metadata dependency: ${id}`);
        }
        active.add(id);
        if (node.type === "metadata") {
          safePath(node.path);
          const text = reader.read(node.repository, node.path);
          if (sha256(text) !== node.digest) {
            reject(`metadata digest changed: ${id}`);
          }
          const parsed = parseDocument(text);
          if (parsed.isErr()) {
            throw parsed.error;
          }
          unique(
            node.jobs.map((job) => job.id),
            "callee job classification",
          );
          if (
            JSON.stringify(Object.keys(parsed.value.jobs).toSorted()) !==
            JSON.stringify(node.jobs.map((job) => job.id).toSorted())
          ) {
            reject(`callee job classification totality mismatch: ${id}`);
          }
          for (const job of node.jobs) {
            if (parsed.value.jobs[job.id]?.digest !== job.digest) {
              reject(`callee job digest changed: ${id}/${job.id}`);
            }
            classifications[job.kind] += 1;
            jobCount += 1;
          }
          const references = new Set(
            [
              ...Object.values(parsed.value.jobs).flatMap((job) => job.steps),
              ...parsed.value.steps,
            ].flatMap((step) => (step.uses === null ? [] : [step.uses])),
          );
          if (
            Object.keys(node.edges).length !== references.size ||
            Object.keys(node.edges).some((ref) => !references.has(ref))
          ) {
            reject(`metadata edge totality mismatch: ${id}`);
          }
          const reusableWorkflows = new Set(
            Object.values(parsed.value.jobs).flatMap((job) =>
              job.reusableWorkflow === null ? [] : [job.reusableWorkflow],
            ),
          );
          for (const reference of references) {
            const targetId = node.edges[reference];
            const target = targetId ? nodes.get(targetId) : undefined;
            if (!targetId || !target) {
              reject(`undeclared metadata edge: ${id}/${reference}`);
            }
            verifyReference({
              callerRepository: node.repository,
              target,
              reference,
              kind: reusableWorkflows.has(reference)
                ? "reusable-workflow"
                : "action",
            });
            visit(targetId);
          }
          documentCount += 1;
        }
        active.delete(id);
        visited.add(id);
      };
      for (const workflow of metadata.workflows) {
        const node = nodes.get(workflow.node);
        if (
          node?.type !== "metadata" ||
          node.repository !== metadata.repository ||
          node.path !== workflow.path ||
          node.jobs.length === 0
        ) {
          reject("workflow metadata root mismatch");
        }
        visit(workflow.node);
      }
      if (visited.size !== nodes.size) {
        reject("unreachable metadata declaration");
      }
      return {
        workflowCount: metadata.workflows.length,
        jobCount,
        documentCount,
        classifications,
        dependencyCount: visited.size,
      };
    },
    catch: (cause) =>
      new AdmissionError({
        message:
          cause instanceof Error ? cause.message : "metadata source failure",
      }),
  });

// Configured frozen root revisions are deliberately ignored. Candidate YAML is
// always read from this checkout's HEAD. Remote pinned sources keep their refs.
export const createCandidateMetadataReader = (
  config: v.InferOutput<typeof SOURCE_CONFIG>,
  repository: string,
): MetadataReader => {
  const root = config[repository];
  if (!root) {
    reject("candidate source configuration missing");
  }
  const revision = resolveGitHead(root.directory);
  const provider = createGitProvider({
    ...config,
    [repository]: { directory: root.directory, revision },
  });
  return {
    workflows: () => provider.workflows(repository),
    read: provider.read,
  };
};
if (import.meta.main) {
  try {
    const [repository, manifestPath, configPath, ...extra] =
      process.argv.slice(2);
    if (!repository || !manifestPath || !configPath || extra.length) {
      reject(
        "usage: bun public-metadata.ts ROOT_REPOSITORY MANIFEST PUBLIC_GIT_SOURCES",
      );
    }
    const manifest = v.parse(
      PUBLIC_METADATA,
      JSON.parse(readFileSync(manifestPath, "utf-8")),
    );
    if (manifest.repository !== repository) {
      reject("candidate repository identity mismatch");
    }
    const result = verifyPublicMetadata({
      manifest,
      reader: createCandidateMetadataReader(
        v.parse(SOURCE_CONFIG, JSON.parse(readFileSync(configPath, "utf-8"))),
        repository,
      ),
    });
    if (result.isErr()) {
      process.stderr.write(`${result.error.message}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(
        `${JSON.stringify({ mode: "public-metadata", ...result.value })}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "metadata census failed"}\n`,
    );
    process.exitCode = 1;
  }
}

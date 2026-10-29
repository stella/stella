import { Result } from "better-result";
import * as v from "valibot";

import { compareCodeUnit } from "../../packages/collation/src/collation";
import { CLASSIFICATIONS, sha256 } from "./classification-values";
import { createGitProvider, resolveGitHead } from "./git-provider";
import type { SOURCE_CONFIG } from "./git-provider";
import {
  METADATA_ORIGIN,
  metadataReferenceIdentity,
  parseRemoteReference,
  recordMetadataMount,
  resolveLocalMetadataPath,
  sameMetadataOrigin,
  verifyRemoteReference,
} from "./references";
import type { MetadataOrigin, MetadataReferenceKind } from "./references";
import { AdmissionError, parseDocument } from "./yaml";
import type { ParsedDocument } from "./yaml";

const REVIEW_INSTRUCTION =
  "review the matching file in .github/ci-job-classification-decisions/";

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
  origin: METADATA_ORIGIN,
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
// An explicit type annotation lets control-flow analysis narrow after calls.
const reject: (message: string) => never = (message) => {
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
type ReferenceOptions = {
  callerRepository: string;
  callerOrigin: MetadataOrigin;
  target: PublicMetadata["nodes"][number];
  reference: string;
  kind: MetadataReferenceKind;
  inheritedMount: string | null;
  relocatedActions: Record<
    string,
    { repository: string | null; ref: string | null; path: string }[]
  >;
};
const verifyReference = ({
  callerRepository,
  callerOrigin,
  target,
  reference,
  kind,
  relocatedActions,
  inheritedMount,
}: ReferenceOptions) => {
  if (
    kind === "reusable-workflow" &&
    (target.type !== "metadata" || target.jobs.length === 0)
  ) {
    reject("reusable workflow requires callee job metadata");
  }
  let targetMount: string | null = null;
  if (target.type === "metadata") {
    const local = reference.startsWith("./") || reference.startsWith("$/");
    if (!local) {
      verifyRemoteReference({
        reference,
        origin: target.origin,
        path: target.path,
        kind,
      });
    } else {
      const selected = resolveLocalMetadataPath({
        reference,
        kind,
        relocations: relocatedActions[reference] ?? [],
        inheritedMount,
      });
      targetMount = selected.mount;
      const exactPath =
        kind === "reusable-workflow"
          ? target.path === selected.path
          : target.path === `${selected.path}/action.yml` ||
            target.path === `${selected.path}/action.yaml`;
      if (
        target.repository !== callerRepository ||
        !sameMetadataOrigin({ caller: callerOrigin, target: target.origin }) ||
        !exactPath
      ) {
        reject("local metadata path, repository or origin mismatch");
      }
    }
    if (
      !target.references.some(
        (declared) =>
          metadataReferenceIdentity(declared, target.repository) ===
          metadataReferenceIdentity(reference, callerRepository),
      )
    ) {
      reject("callee metadata reference mismatch");
    }
  } else {
    if (reference.startsWith("$/") || reference.startsWith("./")) {
      reject("local action requires metadata source");
    }
    if (reference !== target.reference) {
      reject("supplier reference mismatch");
    }
    if (target.binding === "immutable") {
      if (reference.startsWith("docker://")) {
        if (!/^docker:\/\/[^\s]+@sha256:[0-9a-f]{64}$/u.test(reference)) {
          reject("mutable supplier marked immutable");
        }
      } else {
        parseRemoteReference(reference);
      }
    }
  }
  return targetMount;
};

const verifyWorkflowInventory = (
  metadata: PublicMetadata,
  reader: MetadataReader,
) => {
  const observed = reader.workflows().toSorted();
  unique(observed, "observed workflow");
  if (
    JSON.stringify(observed) !==
    JSON.stringify(
      metadata.workflows.map((workflow) => workflow.path).toSorted(),
    )
  ) {
    reject(
      `Unclassified workflows: ${observed.filter((path) => !metadata.workflows.some((workflow) => workflow.path === path)).join(", ")}. Classify their jobs, then ${REVIEW_INSTRUCTION}`,
    );
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
      verifyWorkflowInventory(metadata, reader);
      const nodes = new Map(metadata.nodes.map((node) => [node.id, node]));
      const visited = new Set<string>();
      const mounts = new Map<string, string>();
      const active = new Set<string>();
      const classifications = { ordinary: 0, support: 0, priority: 0 };
      const parsedDocuments = new Map<string, ParsedDocument>();
      let jobCount = 0;
      let documentCount = 0;
      const visit = (id: string, mount: string | null = null): void => {
        if (active.has(id)) {
          reject("metadata dependency cycle");
        }
        const node = nodes.get(id);
        if (!node) {
          reject(`missing metadata dependency: ${id}`);
        }
        if (node.type === "metadata") {
          const definition = parsedDocuments.get(id);
          if (definition) {
            recordMetadataMount({
              mounts,
              identity: id,
              mount,
              document: definition,
            });
          }
        }
        if (visited.has(id)) {
          return;
        }
        active.add(id);
        if (node.type === "metadata") {
          safePath(node.path);
          const text = reader.read(node.repository, node.path);
          const parsed = parseDocument(text);
          if (parsed.isErr()) {
            throw parsed.error;
          }
          parsedDocuments.set(id, parsed.value);
          recordMetadataMount({
            mounts,
            identity: id,
            mount,
            document: parsed.value,
          });
          unique(
            node.jobs.map((job) => job.id),
            "callee job classification",
          );
          if (
            JSON.stringify(Object.keys(parsed.value.jobs).toSorted()) !==
            JSON.stringify(node.jobs.map((job) => job.id).toSorted())
          ) {
            reject(
              `Unclassified or removed jobs: ${node.path}: ${Object.keys(
                parsed.value.jobs,
              )
                .filter((job) => !node.jobs.some((entry) => entry.id === job))
                .join(", ")}. Classify new jobs, then ${REVIEW_INSTRUCTION}`,
            );
          }
          for (const job of node.jobs) {
            classifications[job.kind] += 1;
            jobCount += 1;
          }
          const references = new Set(Object.keys(parsed.value.dependencies));
          if (
            Object.keys(node.edges).length !== references.size ||
            Object.keys(node.edges).some((ref) => !references.has(ref))
          ) {
            reject(`metadata edge totality mismatch: ${id}`);
          }
          for (const [reference, kind] of Object.entries(
            parsed.value.dependencies,
          )) {
            const targetId = node.edges[reference];
            const target = targetId ? nodes.get(targetId) : undefined;
            if (!targetId || !target) {
              reject(`undeclared metadata edge: ${id}/${reference}`);
            }
            const targetMount = verifyReference({
              callerRepository: node.repository,
              callerOrigin: node.origin,
              target,
              reference,
              kind,
              relocatedActions: parsed.value.relocatedActions,
              inheritedMount: mount,
            });
            visit(targetId, targetMount);
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
      const documentDigests = new Map<string, string>();
      const documentDigest = (id: string): string => {
        const cached = documentDigests.get(id);
        if (cached) {
          return cached;
        }
        const node = nodes.get(id);
        const parsed = parsedDocuments.get(id);
        if (!node || node.type !== "metadata" || !parsed) {
          return id;
        }
        const dependencies = Object.fromEntries(
          Object.entries(node.edges)
            .filter(([, target]) => nodes.get(target)?.type === "metadata")
            .toSorted(([left], [right]) => compareCodeUnit(left, right))
            .map(([reference, target]) => [reference, documentDigest(target)]),
        );
        const digest = Object.keys(dependencies).length
          ? sha256(JSON.stringify({ digest: parsed.digest, dependencies }))
          : parsed.digest;
        documentDigests.set(id, digest);
        return digest;
      };
      for (const node of nodes.values()) {
        if (node.type !== "metadata") {
          continue;
        }
        const parsed = parsedDocuments.get(node.id);
        if (!parsed) {
          reject("parsed metadata missing");
        }
        const changedJobs = node.jobs.filter((job) => {
          const definition = parsed.jobs[job.id];
          if (!definition) {
            return true;
          }
          const dependencies = Object.fromEntries(
            Object.keys(definition.dependencies)
              .toSorted(compareCodeUnit)
              .flatMap((reference) => {
                const target = node.edges[reference];
                return target && nodes.get(target)?.type === "metadata"
                  ? [[reference, documentDigest(target)]]
                  : [];
              }),
          );
          const digest = Object.keys(dependencies).length
            ? sha256(
                JSON.stringify({ digest: definition.digest, dependencies }),
              )
            : definition.digest;
          return digest !== job.digest && definition.digest !== job.digest;
        });
        if (changedJobs.length) {
          reject(
            `Classification-relevant shape changed: ${changedJobs.map((job) => `${node.path}/${job.id}`).join(", ")}. Re-review kind and qualifier, then ${REVIEW_INSTRUCTION}`,
          );
        }
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

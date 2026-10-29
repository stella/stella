import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import {
  CLASSIFICATIONS,
  sha256,
} from "../../../scripts/ci-job-classification/classification-values";
import {
  decisionKeyFromPath,
  readDecisions,
  writeDecision,
} from "../../../scripts/ci-job-classification/decisions";
import {
  generateClassification,
  readClassificationInputs,
} from "../../../scripts/ci-job-classification/generate";
import type { ClassificationDecisionsInput } from "../../../scripts/ci-job-classification/generate";
import {
  CLASSIFICATION_DECISIONS_PATH,
  CLASSIFICATION_INPUT_PATHS,
  decisionPathForKey,
} from "../../../scripts/ci-job-classification/inputs";
import {
  createCandidateMetadataReader,
  PUBLIC_METADATA,
  verifyPublicMetadata,
} from "../../../scripts/ci-job-classification/public-metadata";
import type {
  MetadataReader,
  PublicMetadata,
} from "../../../scripts/ci-job-classification/public-metadata";
import { parseRemoteReference } from "../../../scripts/ci-job-classification/references";
import type { MetadataOrigin } from "../../../scripts/ci-job-classification/references";
import {
  isPrivilegedJob,
  ReviewRequiredError,
} from "../../../scripts/ci-job-classification/review";
import {
  AdmissionError,
  CLASSIFICATION_EXCLUSIONS,
  parseDocument,
} from "../../../scripts/ci-job-classification/yaml";

const ORDINARY = CLASSIFICATIONS[0];
const SUPPORT = CLASSIFICATIONS[1];
const repositoryRoot = path.resolve(import.meta.dir, "../../..");
const githubExpression = (expression: string) =>
  ["$", "{{ ", expression, " }}"].join("");

test("every committed decision key has a unique reversible path", () => {
  const decisions = readDecisions({
    type: "working-tree",
    root: repositoryRoot,
  });
  const files = Object.keys(decisions).map(decisionPathForKey);
  expect(new Set(files).size).toBe(files.length);
  for (const decisionKey of Object.keys(decisions)) {
    expect(decisionKeyFromPath(decisionPathForKey(decisionKey))).toBe(
      decisionKey,
    );
  }
});

test("revision decision reads support both the directory and legacy file", () => {
  const root = mkdtempSync(path.join(tmpdir(), "classification-layout-"));
  const key = "candidate:.github/workflows/ci.yml/check";
  const value = {
    kind: ORDINARY,
    qualifier: "Reviewed",
    reviewedDigest: "0".repeat(64),
  };
  const normalized = {
    kind: value.kind,
    qualifier: value.qualifier,
    approvedDigests: [value.reviewedDigest],
  };
  const git = (args: string[]) => Bun.spawnSync(["git", "-C", root, ...args]);
  try {
    expect(git(["init", "--quiet"]).exitCode).toBe(0);
    writeDecision(root, key, value);
    expect(git(["add", "."]).exitCode).toBe(0);
    expect(
      git([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "directory",
      ]).exitCode,
    ).toBe(0);
    expect(
      readDecisions({ type: "git-revision", root, revision: "HEAD" }),
    ).toEqual({ [key]: normalized });

    rmSync(path.join(root, CLASSIFICATION_DECISIONS_PATH), {
      recursive: true,
    });
    writeFileSync(
      path.join(root, `${CLASSIFICATION_DECISIONS_PATH}.json`),
      JSON.stringify({ [key]: value }),
    );
    expect(git(["add", "-A"]).exitCode).toBe(0);
    expect(
      git([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "legacy",
      ]).exitCode,
    ).toBe(0);
    expect(
      readDecisions({ type: "git-revision", root, revision: "HEAD" }),
    ).toEqual({ [key]: value });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("committed classifications cover the repository and its pinned metadata callees", () => {
  const inputs = readClassificationInputs(repositoryRoot);
  const { decisions, snapshots } = inputs;
  const generated = generateClassification(inputs);
  if (generated.isErr()) {
    throw generated.error;
  }
  const manifest = generated.value;
  // Parsing must preserve all reviewed decisions and pinned supplier metadata.
  expect(readDecisions({ type: "working-tree", root: repositoryRoot })).toEqual(
    decisions,
  );
  expect(snapshots).toEqual(
    JSON.parse(
      readFileSync(
        path.join(repositoryRoot, ".github/ci-job-classification-sources.json"),
        "utf-8",
      ),
    ),
  );
  expect(fixtureDecisions(manifest)).toEqual(decisions);
  expect(manifest.workflows.length).toBeGreaterThan(0);
  expect(
    manifest.nodes.some(
      (node) =>
        node.type === "metadata" &&
        node.jobs.some((job) => job.kind === "priority"),
    ),
  ).toBe(true);
  const declared = manifest.nodes
    .flatMap((node) =>
      node.type === "metadata" && node.repository === "candidate"
        ? [node.path]
        : [],
    )
    .filter((file) => file.startsWith(".github/actions/"))
    .toSorted();
  const actions = [
    ...new Bun.Glob(".github/actions/*/action.{yml,yaml}").scanSync({
      cwd: repositoryRoot,
    }),
  ].toSorted();
  expect(actions.length).toBeGreaterThan(0);
  expect(declared).toEqual(actions);
  // Parses every reachable workflow and action document in a child process.
}, 60_000);

test("the classification CLI accepts an explicit check flag and source directory", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      path.join(repositoryRoot, "scripts/check-ci-job-classification.ts"),
      "--check",
      repositoryRoot,
      "--base",
      "HEAD",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(new TextDecoder().decode(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toMatch(
    /(?:^|\n)Classified \d+ workflows\n$/u,
  );
}, 60_000);

test("the consolidated quick checks retain the support classification of the jobs they replace", () => {
  const { decisions } = readClassificationInputs(repositoryRoot);
  expect(
    decisions["candidate:.github/workflows/ci.yml/ci-quick-checks"]?.kind,
  ).toBe(SUPPORT);
});

test("the quick checks invoke classification after a successful install", () => {
  const workflow: unknown = Bun.YAML.parse(
    readFileSync(
      path.join(repositoryRoot, ".github/workflows/ci.yml"),
      "utf-8",
    ),
  );
  const policy = v.parse(
    v.object({
      jobs: v.object({
        "ci-quick-checks": v.object({
          steps: v.array(
            v.looseObject({
              name: v.optional(v.string()),
              id: v.optional(v.string()),
              uses: v.optional(v.string()),
              run: v.optional(v.string()),
              if: v.optional(v.string()),
              with: v.optional(v.record(v.string(), v.unknown())),
              env: v.optional(v.record(v.string(), v.unknown())),
              "continue-on-error": v.optional(v.boolean()),
            }),
          ),
        }),
      }),
    }),
    workflow,
  ).jobs["ci-quick-checks"].steps;
  const install = policy.findIndex((step) => step.id === "install");
  const check = policy.findIndex(
    (step) =>
      step.run ===
      `trap 'rm -rf "$GITHUB_WORKSPACE/.workflow-tooling"' EXIT\ncd .workflow-tooling\nbun scripts/check-ci-job-classification.ts\n`,
  );
  expect(install).toBeGreaterThanOrEqual(0);
  expect(check).toBeGreaterThan(install);
  const checkout = policy.findIndex(
    (step) => step.with?.["path"] === ".workflow-tooling",
  );
  expect(checkout).toBeGreaterThan(install);
  expect(check).toBeGreaterThan(checkout);
  expect(policy.at(checkout)?.uses).toMatch(
    /^actions\/checkout@[0-9a-f]{40}$/u,
  );
  expect(policy.at(checkout)?.with?.["ref"]).toBe(
    githubExpression("github.workflow_sha"),
  );
  expect(policy.at(checkout)?.with?.["persist-credentials"]).toBe(false);
  expect(policy.at(checkout)?.with?.["fetch-depth"]).toBe(0);
  // The tooling checkout holds exactly what the classification reads.
  expect(
    String(policy.at(checkout)?.with?.["sparse-checkout"]).trim().split("\n"),
  ).toEqual([...CLASSIFICATION_INPUT_PATHS]);
  for (const index of [checkout, check]) {
    const step = policy.at(index);
    expect(step?.if).toBe(
      "!cancelled() && steps.install.outcome == 'success' && needs.ci-plan.outputs.package_checks_required == 'true' && needs.ci-plan.outputs.run_required != 'false' && (needs.ci-plan.outputs.trusted == 'true' || github.event_name == 'workflow_dispatch') && (github.event_name == 'merge_group' || needs.ci-plan.outputs.pr_depth_reused != 'true')",
    );
    expect(step?.env?.["CI_CHECK_KIND"]).toBe("CONTEXTUAL");
    expect(step?.if).not.toContain("static_receipts");
    expect(step?.["continue-on-error"]).toBeUndefined();
  }
});
const fixture = () => {
  const workflow =
    "jobs:\n  caller:\n    steps:\n      - parallel:\n          - uses: $/.github/actions/local\n  reusable:\n    uses: vendor/shared/.github/workflows/reusable.yml@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n";
  const action = "runs: {using: composite, steps: [{run: 'bun script.ts'}]}";
  const callee = "jobs: {child: {steps: [{run: 'echo child'}]}}";
  type SourceFixtureOptions = {
    id: string;
    repository: string;
    origin: MetadataOrigin;
    file: string;
    text: string;
    references: string[];
    edges: Record<string, string>;
  };
  const source = ({
    id,
    repository,
    origin,
    file,
    text,
    references,
    edges,
  }: SourceFixtureOptions) => {
    const parsed = parseDocument(text);
    if (parsed.isErr()) {
      throw parsed.error;
    }
    return {
      type: "metadata",
      id,
      repository,
      origin,
      path: file,
      digest: parsed.value.digest,
      references,
      edges,
      jobs: Object.entries(parsed.value.jobs).map(([jobId, job]) => ({
        id: jobId,
        kind: ORDINARY,
        qualifier: "Reviewed checks",
        digest: job.digest,
      })),
    } satisfies PublicMetadata["nodes"][number];
  };
  const manifest: PublicMetadata = {
    version: 1,
    mode: "public-metadata",
    repository: "candidate",
    workflows: [{ path: ".github/workflows/ci.yml", node: "root" }],
    nodes: [
      source({
        id: "root",
        repository: "candidate",
        origin: { type: "checkout" },
        file: ".github/workflows/ci.yml",
        text: workflow,
        references: [],
        edges: {
          "$/.github/actions/local": "action",
          "vendor/shared/.github/workflows/reusable.yml@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":
            "callee",
        },
      }),
      source({
        id: "action",
        repository: "candidate",
        origin: { type: "checkout" },
        file: ".github/actions/local/action.yml",
        text: action,
        references: ["$/.github/actions/local"],
        edges: {},
      }),
      source({
        id: "callee",
        repository: "public-supplier@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        origin: {
          type: "git",
          owner: "vendor",
          repo: "shared",
          sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        file: ".github/workflows/reusable.yml",
        text: callee,
        references: [
          "vendor/shared/.github/workflows/reusable.yml@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ],
        edges: {},
      }),
    ],
  };
  const root = manifest.nodes.find((node) => node.id === "root");
  if (root?.type === "metadata") {
    const actionDigest = parseDocument(action);
    const calleeDigest = parseDocument(callee);
    const parsedRoot = parseDocument(workflow);
    if (actionDigest.isErr() || calleeDigest.isErr() || parsedRoot.isErr()) {
      throw new AdmissionError({ message: "fixture digest parsing failed" });
    }
    root.jobs = root.jobs.map((job) => {
      const definition = parsedRoot.value.jobs[job.id];
      if (!definition) {
        return job;
      }
      const dependencies =
        job.id === "caller"
          ? { "$/.github/actions/local": actionDigest.value.digest }
          : {
              "vendor/shared/.github/workflows/reusable.yml@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":
                calleeDigest.value.digest,
            };
      return {
        ...job,
        digest: sha256(
          JSON.stringify({ digest: definition.digest, dependencies }),
        ),
      };
    });
  }
  const documents = new Map([
    ["candidate:.github/workflows/ci.yml", workflow],
    ["candidate:.github/actions/local/action.yml", action],
    [
      "public-supplier@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:.github/workflows/reusable.yml",
      callee,
    ],
  ]);
  const reader: MetadataReader = {
    workflows: () => [".github/workflows/ci.yml"],
    read: (repo, file) => {
      const text = documents.get(`${repo}:${file}`);
      if (!text) {
        throw new AdmissionError({ message: "metadata missing" });
      }
      return text;
    },
  };
  return { manifest, reader, documents };
};
const failure = (
  result: ReturnType<typeof verifyPublicMetadata>,
  message: string,
) => {
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain(message);
  }
};
test("censuses every root, local action and reusable callee job without execution trees", () => {
  const f = fixture();
  const result = verifyPublicMetadata(f);
  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value).toEqual({
      workflowCount: 1,
      jobCount: 3,
      documentCount: 3,
      classifications: { ordinary: 3, support: 0, priority: 0 },
      dependencyCount: 3,
    });
  }
});
test("job-level reusable calls cannot replace callee classifications with a pinned supplier", () => {
  const f = fixture();
  const manifest: PublicMetadata = {
    ...f.manifest,
    nodes: f.manifest.nodes.map((node) =>
      node.id === "callee"
        ? {
            type: "supplier",
            id: node.id,
            reference:
              "vendor/shared/.github/workflows/reusable.yml@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            binding: "immutable",
          }
        : node,
    ),
  };
  failure(
    verifyPublicMetadata({ manifest, reader: f.reader }),
    "reusable workflow requires callee job metadata",
  );
});
type ReboundReferenceOptions = {
  original: string;
  replacement: string;
  target: string;
  repository?: string;
  targetPath?: string;
  origin?: MetadataOrigin;
};
const reboundReference = ({
  original,
  replacement,
  target,
  repository,
  targetPath,
  origin,
}: ReboundReferenceOptions) => {
  const f = fixture();
  const rootKey = "candidate:.github/workflows/ci.yml";
  const originalWorkflow = f.documents.get(rootKey);
  if (originalWorkflow === undefined || !originalWorkflow.includes(original)) {
    throw new AdmissionError({ message: "reference fixture missing" });
  }
  const workflow = originalWorkflow.replace(original, () => replacement);
  const parsed = parseDocument(workflow);
  if (parsed.isErr()) {
    throw parsed.error;
  }
  f.documents.set(rootKey, workflow);
  const manifest: PublicMetadata = {
    ...f.manifest,
    nodes: f.manifest.nodes.map((node) => {
      if (node.type !== "metadata") {
        return node;
      }
      if (node.id === "root") {
        return {
          ...node,
          digest: parsed.value.digest,
          jobs: node.jobs.map((job) => {
            const definition = parsed.value.jobs[job.id];
            if (!definition) {
              throw new AdmissionError({
                message: "reference fixture job missing",
              });
            }
            return { ...job, digest: definition.digest };
          }),
          edges: Object.fromEntries(
            Object.entries(node.edges).map(([reference, destination]) => [
              reference === original ? replacement : reference,
              destination,
            ]),
          ),
        };
      }
      if (node.id !== target) {
        return node;
      }
      const text = f.documents.get(`${node.repository}:${node.path}`);
      if (text === undefined) {
        throw new AdmissionError({ message: "target fixture missing" });
      }
      const updated = {
        ...node,
        repository: repository ?? node.repository,
        origin: origin ?? node.origin,
        path: targetPath ?? node.path,
        references: node.references.map((reference) =>
          reference === original ? replacement : reference,
        ),
      };
      f.documents.set(`${updated.repository}:${updated.path}`, text);
      return updated;
    }),
  };
  return { manifest, reader: f.reader };
};
test("remote reusable references cannot authorize metadata from a different workflow path", () => {
  failure(
    verifyPublicMetadata(
      reboundReference({
        original:
          "vendor/shared/.github/workflows/reusable.yml@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        replacement:
          "vendor/shared/.github/workflows/new.yml@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        target: "callee",
      }),
    ),
    "remote metadata path mismatch",
  );
});
test("remote metadata origins remain independent of changed reference declarations", () => {
  for (const replacement of [
    "other/shared/.github/workflows/reusable.yml@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "vendor/other/.github/workflows/reusable.yml@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "vendor/shared/.github/workflows/reusable.yml@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  ]) {
    failure(
      verifyPublicMetadata(
        reboundReference({
          original:
            "vendor/shared/.github/workflows/reusable.yml@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          replacement,
          target: "callee",
        }),
      ),
      "remote metadata origin mismatch",
    );
  }
});
test("remote sources cannot substitute checkout origin for independently pinned Git origin", () => {
  const f = fixture();
  const manifest: PublicMetadata = {
    ...f.manifest,
    nodes: f.manifest.nodes.map((node) =>
      node.type === "metadata" && node.id === "callee"
        ? { ...node, origin: { type: "checkout" } }
        : node,
    ),
  };
  failure(
    verifyPublicMetadata({ manifest, reader: f.reader }),
    "remote metadata origin mismatch",
  );
  expect(
    v.safeParse(PUBLIC_METADATA, {
      ...f.manifest,
      nodes: f.manifest.nodes.map((node) =>
        node.type === "metadata" ? { ...node, origin: undefined } : node,
      ),
    }).success,
  ).toBe(false);
});
test("remote references have one canonical immutable tuple parser", () => {
  expect(
    parseRemoteReference(
      "Vendor/Shared/nested@AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ),
  ).toEqual({
    owner: "vendor",
    repo: "shared",
    path: "nested",
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  expect(
    parseRemoteReference(
      "vendor/shared@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ).path,
  ).toBe("");
  for (const reference of [
    "vendor/shared@main",
    "vendor/shared/@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "vendor/shared/../other@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ]) {
    expect(() => parseRemoteReference(reference)).toThrow(
      "invalid remote metadata reference",
    );
  }
});
test("local reusable workflows cannot use workspace aliases to change path or repository", () => {
  for (const route of [
    { replacement: "./.github/workflows/new.yml", repository: "candidate" },
    {
      replacement: "./.github/workflows/reusable.yml",
      repository: "candidate",
    },
    {
      replacement: "./.github/workflows/reusable.yml",
      repository: "public-supplier@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  ]) {
    failure(
      verifyPublicMetadata(
        reboundReference({
          original:
            "vendor/shared/.github/workflows/reusable.yml@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ...route,
          target: "callee",
        }),
      ),
      "local metadata path, repository or origin mismatch",
    );
  }
});
test("relative actions bind metadata to the caller repository and origin", () => {
  for (const route of [
    {
      repository: "other",
      targetPath: ".github/actions/local/action.yml",
      message: "local metadata path, repository or origin mismatch",
    },
    {
      repository: "candidate",
      targetPath: ".github/actions/local/action.yml",
      origin: {
        type: "git",
        owner: "vendor",
        repo: "shared",
        sha: "a".repeat(40),
      } satisfies MetadataOrigin,
      message: "local metadata path, repository or origin mismatch",
    },
  ]) {
    failure(
      verifyPublicMetadata(
        reboundReference({
          original: "$/.github/actions/local",
          replacement: "./.github/actions/local",
          target: "action",
          ...route,
        }),
      ),
      route.message,
    );
  }
});
test("remote action references bind the directory or repository-root action metadata path", () => {
  for (const route of [
    {
      replacement: "vendor/shared@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      targetPath: "action.yml",
    },
    {
      replacement:
        "vendor/shared/nested@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      targetPath: "nested/action.yaml",
    },
  ]) {
    expect(
      verifyPublicMetadata(
        reboundReference({
          original: "$/.github/actions/local",
          target: "action",
          repository:
            "public-supplier@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          origin: {
            type: "git",
            owner: "vendor",
            repo: "shared",
            sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
          ...route,
        }),
      ).isOk(),
    ).toBe(true);
  }
  failure(
    verifyPublicMetadata(
      reboundReference({
        original: "$/.github/actions/local",
        target: "action",
        repository: "public-supplier@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        origin: {
          type: "git",
          owner: "vendor",
          repo: "shared",
          sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        replacement:
          "vendor/shared/other@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ),
    "remote metadata path mismatch",
  );
});
test("a callee cannot hide new jobs, changes or missing classifications", () => {
  const f = fixture();
  const changed: PublicMetadata = {
    ...f.manifest,
    nodes: f.manifest.nodes.map((node) =>
      node.type === "metadata" && node.id === "callee"
        ? { ...node, jobs: [] }
        : node,
    ),
  };
  failure(
    verifyPublicMetadata({ manifest: changed, reader: f.reader }),
    "reusable workflow requires callee job metadata",
  );
  f.documents.set(
    "public-supplier@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:.github/workflows/reusable.yml",
    "jobs: {hidden: {steps: [{run: 'publish'}]}}",
  );
  failure(verifyPublicMetadata(f), "Unclassified or removed jobs");
});
test("same-repository aliases cannot redirect source-relative action metadata", () => {
  const f = fixture();
  const manifest: PublicMetadata = {
    ...f.manifest,
    nodes: f.manifest.nodes.map((node) =>
      node.type === "metadata" && node.id === "action"
        ? { ...node, path: ".github/actions/different/action.yml" }
        : node,
    ),
  };
  const original = f.documents.get(
    "candidate:.github/actions/local/action.yml",
  );
  if (original === undefined) {
    throw new AdmissionError({ message: "action fixture missing" });
  }
  f.documents.set("candidate:.github/actions/different/action.yml", original);
  failure(
    verifyPublicMetadata({ manifest, reader: f.reader }),
    "local metadata path, repository or origin mismatch",
  );
});
test("checkout-local action references cannot redirect metadata without a verified relocation", () => {
  failure(
    verifyPublicMetadata(
      reboundReference({
        original: "$/.github/actions/local",
        replacement: "./.github/actions/local",
        target: "action",
        targetPath: ".github/actions/different/action.yml",
      }),
    ),
    "local metadata path, repository or origin mismatch",
  );
});
const relocatedActionFixture = ({
  checkoutRepository,
  targetPath = ".github/actions/local/action.yml",
}: {
  checkoutRepository?: string;
  targetPath?: string;
}) => {
  const f = fixture();
  const repository = checkoutRepository
    ? `\n          repository: ${checkoutRepository}`
    : "";
  const workflow = `jobs:
  caller:
    steps:
      - uses: actions/checkout@${"c".repeat(40)}
        with:
          path: .workflow-actions
          ref: \${{ github.workflow_sha }}${repository}
      - uses: ./.workflow-actions/.github/actions/local
  reusable:
    uses: vendor/shared/.github/workflows/reusable.yml@${"a".repeat(40)}
`;
  const parsed = parseDocument(workflow);
  if (parsed.isErr()) {
    throw parsed.error;
  }
  f.documents.set("candidate:.github/workflows/ci.yml", workflow);
  const action = f.documents.get("candidate:.github/actions/local/action.yml");
  if (action === undefined) {
    throw new AdmissionError({ message: "action fixture missing" });
  }
  f.documents.set(`candidate:${targetPath}`, action);
  return {
    reader: f.reader,
    manifest: {
      ...f.manifest,
      nodes: [
        ...f.manifest.nodes.map((node) => {
          if (node.type !== "metadata") {
            return node;
          }
          if (node.id === "root") {
            return {
              ...node,
              digest: parsed.value.digest,
              jobs: node.jobs.map((job) => ({
                ...job,
                digest: parsed.value.jobs[job.id]?.digest ?? job.digest,
              })),
              edges: {
                "./.workflow-actions/.github/actions/local": "action",
                "actions/checkout@cccccccccccccccccccccccccccccccccccccccc":
                  "checkout",
                "vendor/shared/.github/workflows/reusable.yml@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":
                  "callee",
              },
            };
          }
          if (node.id === "action") {
            return {
              ...node,
              path: targetPath,
              references: ["./.workflow-actions/.github/actions/local"],
            };
          }
          return node;
        }),
        {
          type: "supplier",
          id: "checkout",
          reference:
            "actions/checkout@cccccccccccccccccccccccccccccccccccccccc",
          binding: "immutable",
        },
      ],
    } satisfies PublicMetadata,
  };
};
test("checkout-relative action aliases bind to their source repository and path", () => {
  const valid = relocatedActionFixture({});
  expect(verifyPublicMetadata(valid).isOk()).toBe(true);

  failure(
    verifyPublicMetadata(
      relocatedActionFixture({
        targetPath: ".github/actions/different/action.yml",
      }),
    ),
    "local metadata path, repository or origin mismatch",
  );
  failure(
    verifyPublicMetadata(
      relocatedActionFixture({ checkoutRepository: "other/repository" }),
    ),
    "local metadata path, repository or origin mismatch",
  );
});
test("local metadata and parallel leaves must have explicit complete edges", () => {
  const f = fixture();
  failure(
    verifyPublicMetadata({
      manifest: {
        ...f.manifest,
        nodes: f.manifest.nodes.filter((node) => node.id !== "action"),
      },
      reader: f.reader,
    }),
    "undeclared metadata edge",
  );
  failure(
    verifyPublicMetadata({
      manifest: f.manifest,
      reader: { ...f.reader, workflows: () => [] },
    }),
    "Unclassified workflows",
  );
  failure(
    verifyPublicMetadata({
      manifest: f.manifest,
      reader: {
        ...f.reader,
        read: () => {
          throw new AdmissionError({ message: "source fault" });
        },
      },
    }),
    "source fault",
  );
});
test("public schema cannot encode a whole-tree authorization exception", () => {
  const f = fixture();
  expect(
    v.safeParse(PUBLIC_METADATA, {
      ...f.manifest,
      nodes: [
        ...f.manifest.nodes,
        {
          type: "opaque-tree",
          id: "tree",
          repository: "candidate",
          digest: sha256("tree"),
          contract: "exclude policy",
        },
      ],
    }).success,
  ).toBe(false);
});
test("candidate reader always observes HEAD even when config names an older revision", () => {
  const root = mkdtempSync(path.join(tmpdir(), "metadata-head-"));
  const git = (args: string[]) => {
    const result = Bun.spawnSync(
      [
        "git",
        "-C",
        root,
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        // Inherited hook variables such as GIT_DIR would redirect `-C root`.
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) => !name.startsWith("GIT_"),
          ),
        ),
      },
    );
    if (result.exitCode !== 0) {
      throw new AdmissionError({ message: "fixture Git failed" });
    }
    return new TextDecoder().decode(result.stdout).trim();
  };
  try {
    git(["init", "--quiet"]);
    mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    writeFileSync(
      path.join(root, ".github/workflows/ci.yml"),
      "jobs: {old: {steps: []}}",
    );
    git(["add", "."]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "baseline",
    ]);
    const old = git(["rev-parse", "HEAD"]);
    writeFileSync(
      path.join(root, ".github/workflows/ci.yml"),
      "jobs: {candidate: {steps: []}}",
    );
    git(["add", "."]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "candidate",
    ]);
    const reader = createCandidateMetadataReader(
      { candidate: { directory: root, revision: old } },
      "candidate",
    );
    expect(reader.read("candidate", ".github/workflows/ci.yml")).toBe(
      "jobs: {candidate: {steps: []}}",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const fixtureDecisions = (
  manifest: PublicMetadata,
): ClassificationDecisionsInput =>
  Object.fromEntries(
    manifest.nodes.flatMap((node) =>
      node.type === "metadata"
        ? node.jobs.map((job) => [
            `${node.repository}:${node.path}/${job.id}`,
            {
              kind: job.kind,
              qualifier: job.qualifier,
              approvedDigests: [job.digest],
            },
          ])
        : [],
    ),
  );

const fixtureGenerationOptions = (f: ReturnType<typeof fixture>) => {
  const root = parseDocument(
    f.reader.read("candidate", ".github/workflows/ci.yml"),
  );
  if (root.isErr()) {
    throw root.error;
  }
  const nodes = new Map(f.manifest.nodes.map((node) => [node.id, node]));
  const documentDigest = (id: string): string => {
    const node = nodes.get(id);
    if (!node || node.type !== "metadata") {
      return id;
    }
    const parsed = parseDocument(f.reader.read(node.repository, node.path));
    if (parsed.isErr()) {
      throw parsed.error;
    }
    const dependencies = Object.fromEntries(
      Object.entries(node.edges)
        .filter(([, target]) => nodes.get(target)?.type === "metadata")
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([reference, target]) => [reference, documentDigest(target)]),
    );
    return Object.keys(dependencies).length
      ? sha256(JSON.stringify({ digest: parsed.value.digest, dependencies }))
      : parsed.value.digest;
  };
  return {
    decisions: Object.fromEntries(
      f.manifest.nodes.flatMap((node) => {
        if (
          node.type !== "metadata" ||
          (node.origin.type === "git" &&
            !node.references.some(
              (reference) => root.value.dependencies[reference],
            ))
        ) {
          return [];
        }
        const parsed = parseDocument(f.reader.read(node.repository, node.path));
        if (parsed.isErr()) {
          throw parsed.error;
        }
        return Object.entries(parsed.value.jobs).map(([id, job]) => [
          `${node.repository}:${node.path}/${id}`,
          {
            kind: ORDINARY,
            qualifier: "Reviewed checks",
            approvedDigests: [
              (() => {
                const dependencies = Object.fromEntries(
                  Object.keys(job.dependencies)
                    .toSorted()
                    .flatMap((reference) => {
                      let target = node.edges[reference];
                      const local =
                        reference.startsWith("./") ||
                        reference.startsWith("$/");
                      if (
                        !target &&
                        local &&
                        job.dependencies[reference] === "action"
                      ) {
                        target = "action";
                      } else if (
                        !target &&
                        job.dependencies[reference] === "reusable-workflow"
                      ) {
                        target = "callee";
                      }
                      return target && nodes.get(target)?.type === "metadata"
                        ? [[reference, documentDigest(target)]]
                        : [];
                    }),
                );
                return Object.keys(dependencies).length
                  ? sha256(JSON.stringify({ digest: job.digest, dependencies }))
                  : job.digest;
              })(),
            ],
          },
        ]);
      }),
    ),
    snapshots: Object.fromEntries(
      f.manifest.nodes.flatMap((node) =>
        node.type === "metadata" && node.origin.type === "git"
          ? [
              [
                node.repository,
                {
                  origin: node.origin,
                  documents: {
                    [node.path]: f.reader.read(node.repository, node.path),
                  },
                },
              ],
            ]
          : [],
      ),
    ),
    reader: f.reader,
    localActionPath: (directory: string) => `${directory}/action.yml`,
  };
};

test("classification ignores unrelated workflow and composite action edits", () => {
  const f = fixture();
  for (const [key, text] of f.documents) {
    const changed = `# editorial comment\n${text.replace("    steps:", "    timeout-minutes: 12\n    name: Renamed job\n    steps:").replace("run: 'bun script.ts'", "name: Renamed step, run: 'bun other.ts'")}`;
    expect(changed).not.toBe(text);
    f.documents.set(key, changed);
  }
  const result = verifyPublicMetadata(f);
  if (result.isErr()) {
    throw result.error;
  }
  expect(result.isOk()).toBe(true);
});

for (const change of [
  "    permissions: {contents: write}\n",
  `    env: {TOKEN: '${githubExpression("secrets.RELEASE_TOKEN")}'}\n`,
  "    environment: production\n",
  "    runs-on: ubuntu-latest\n",
]) {
  test(`classification shape changes require review and refresh: ${change.trim()}`, () => {
    const f = fixture();
    const key = "candidate:.github/workflows/ci.yml";
    const original = f.reader.read("candidate", ".github/workflows/ci.yml");
    const changed = original.replace(
      "  caller:\n",
      () => `  caller:\n${change}`,
    );
    expect(changed).not.toBe(original);
    f.documents.set(key, changed);
    failure(verifyPublicMetadata(f), ".github/workflows/ci.yml/caller");
    failure(
      verifyPublicMetadata(f),
      ".github/ci-job-classification-decisions/",
    );
  });
}

test("new jobs remain unclassified even when refreshing generated metadata", () => {
  const f = fixture();
  const options = fixtureGenerationOptions(f);
  f.documents.set(
    "candidate:.github/workflows/ci.yml",
    `${f.reader.read("candidate", ".github/workflows/ci.yml")}  added:\n    steps: []\n`,
  );
  const result = generateClassification(options);
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain(
      decisionPathForKey("candidate:.github/workflows/ci.yml/added"),
    );
    expect(result.error.message).toContain(
      ".github/ci-job-classification-decisions/",
    );
  }
}, 15_000);

test("classification generation reaches a fixed point and preserves human decisions", () => {
  const f = fixture();
  const options = fixtureGenerationOptions(f);
  const { decisions } = options;
  const first = generateClassification(options);
  if (first.isErr()) {
    throw first.error;
  }
  const second = generateClassification(options);
  if (second.isErr()) {
    throw second.error;
  }
  expect(JSON.stringify(second.value)).toBe(JSON.stringify(first.value));
  expect(fixtureDecisions(second.value)).toEqual(decisions);
}, 15_000);

test("job digests bind exactly the reachable local action closure", () => {
  assertProperty(
    "job digests bind exactly the reachable local action closure",
    fc.property(fc.string({ minLength: 1, maxLength: 40 }), (value) => {
      const f = fixture();
      const options = fixtureGenerationOptions(f);
      const baseline = generateClassification(options);
      if (baseline.isErr()) {
        throw baseline.error;
      }
      const actionKey = "candidate:.github/actions/local/action.yml";
      const originalAction = f.reader.read(
        "candidate",
        ".github/actions/local/action.yml",
      );
      f.documents.set(
        actionKey,
        `runs: {using: composite, steps: [{run: 'bun script.ts', env: {VALUE: ${JSON.stringify(value)}}}]}`,
      );
      const changed = generateClassification(options);
      expect(changed.isErr()).toBe(true);
      if (changed.isErr()) {
        expect(changed.error).toBeInstanceOf(ReviewRequiredError);
        expect(changed.error.message).toContain(
          decisionPathForKey("candidate:.github/workflows/ci.yml/caller"),
        );
        expect(changed.error.message).not.toContain(
          decisionPathForKey("candidate:.github/workflows/ci.yml/reusable"),
        );
      }
      f.documents.set(actionKey, originalAction);
      f.documents.set(
        "candidate:.github/actions/unreachable/action.yml",
        `runs: {using: composite, steps: [{run: ${JSON.stringify(value)}}]}`,
      );
      const unreachable = generateClassification(options);
      if (unreachable.isErr()) {
        throw unreachable.error;
      }
      expect(fixtureDecisions(unreachable.value)).toEqual(options.decisions);
    }),
    { numRuns: 10 },
  );
}, 60_000);

test("classification generation scopes relative action identity to the caller repository", () => {
  const f = fixture();
  const root = f.manifest.nodes.find((node) => node.id === "root");
  const action = f.manifest.nodes.find((node) => node.id === "action");
  if (root?.type !== "metadata" || action?.type !== "metadata") {
    throw new AdmissionError({ message: "source fixture missing" });
  }
  const reference = "./.github/actions/local";
  const workflow = f.reader
    .read("candidate", root.path)
    .replace("$/.github/actions/local", () => reference);
  f.documents.set(`candidate:${root.path}`, workflow);
  f.documents.set(
    "other:.github/actions/local/action.yml",
    f.reader.read("candidate", action.path),
  );
  const generated = generateClassification(fixtureGenerationOptions(f));
  if (generated.isErr()) {
    throw generated.error;
  }
  const generatedRoot = generated.value.nodes.find(
    (node) =>
      node.type === "metadata" &&
      node.repository === "candidate" &&
      node.path === root.path,
  );
  expect(generatedRoot?.type).toBe("metadata");
  if (generatedRoot?.type === "metadata") {
    const target = generated.value.nodes.find(
      (node) => node.id === generatedRoot.edges[reference],
    );
    expect(target?.type).toBe("metadata");
    if (target?.type === "metadata") {
      expect(target.repository).toBe("candidate");
      expect(target.path).toBe(action.path);
    }
  }
  expect(
    generated.value.nodes.some(
      (node) => node.type === "metadata" && node.repository === "other",
    ),
  ).toBe(false);
}, 15_000);

test("real ci.yml classification is stable across comments, timeouts and step names", () => {
  const original = readFileSync(
    path.join(repositoryRoot, ".github/workflows/ci.yml"),
    "utf-8",
  );
  const baseline = parseDocument(original);
  if (baseline.isErr()) {
    throw baseline.error;
  }
  const edits = [
    `# unrelated comment\n${original}`,
    original.replace(/timeout-minutes: \d+/u, "timeout-minutes: 123"),
    original.replace(/- name: [^\n]+/u, "- name: Renamed step"),
  ];
  for (const edited of edits) {
    expect(edited).not.toBe(original);
    const parsed = parseDocument(edited);
    if (parsed.isErr()) {
      throw parsed.error;
    }
    expect(parsed.value.digest).toBe(baseline.value.digest);
  }
});

for (const command of [
  "npm publish",
  "bun deploy",
  "bun release",
  "git push",
]) {
  for (const steps of ["[]", "[{run: 'echo ok'}]"]) {
    test(`unconditional publication commands change job digests: ${steps} to ${command}`, () => {
      const original = parseDocument(`jobs: {ordinary: {steps: ${steps}}}`);
      const changed = parseDocument(
        `jobs: {ordinary: {steps: [{run: '${command}'}]}}`,
      );
      if (original.isErr()) {
        throw original.error;
      }
      if (changed.isErr()) {
        throw changed.error;
      }
      expect(changed.value.jobs["ordinary"]?.digest).not.toBe(
        original.value.jobs["ordinary"]?.digest,
      );
    });
  }
}

test("workflow permission defaults and publication gates enter classification digests", () => {
  for (const [before, after] of [
    [
      "permissions: {contents: read}\njobs: {check: {steps: []}}",
      "permissions: {contents: write}\njobs: {check: {steps: []}}",
    ],
    [
      "jobs: {publish: {steps: [{run: 'bun publish', if: 'false'}]}}",
      "jobs: {publish: {steps: [{run: 'bun publish', if: 'true'}]}}",
    ],
    [
      "jobs: {check: {secrets: inherit, uses: './child.yml'}}",
      "jobs: {check: {secrets: {}, uses: './child.yml'}}",
    ],
  ] satisfies readonly (readonly [string, string])[]) {
    const original = parseDocument(before);
    const changed = parseDocument(after);
    if (original.isErr()) {
      throw original.error;
    }
    if (changed.isErr()) {
      throw changed.error;
    }
    expect(changed.value.digest).not.toBe(original.value.digest);
  }
});

for (const [before, after] of [
  ["with: {push: false}", "with: {push: true}"],
  ["with: {mode: check}", "with: {mode: write}"],
  ["with: {source: value}", "with: {destination: value}"],
  ["env: {MODE: check}", "env: {MODE: write}"],
  ["env: {SOURCE: value}", "env: {DESTINATION: value}"],
] satisfies readonly (readonly [string, string])[]) {
  test(`action configuration changes require classification refresh: ${before}`, () => {
    const f = fixture();
    const workflow = `jobs:\n  caller:\n    steps:\n      - uses: docker/build-push-action@${"a".repeat(40)}\n        if: always()\n        ${before}\n      - run: echo initial\n`;
    const key = "candidate:.github/workflows/ci.yml";
    f.documents.set(key, workflow);
    const options = fixtureGenerationOptions(f);
    const baseline = generateClassification(options);
    if (baseline.isErr()) {
      throw baseline.error;
    }
    const changed = workflow.replace(before, () => after);
    expect(changed).not.toBe(workflow);
    f.documents.set(key, changed);
    failure(
      verifyPublicMetadata({ manifest: baseline.value, reader: f.reader }),
      ".github/workflows/ci.yml/caller",
    );
    failure(
      verifyPublicMetadata({ manifest: baseline.value, reader: f.reader }),
      ".github/ci-job-classification-decisions/",
    );
    const stale = generateClassification(options);
    expect(stale.isErr()).toBe(true);
    if (stale.isErr()) {
      expect(stale.error).toBeInstanceOf(ReviewRequiredError);
    }
    const refreshed = generateClassification(fixtureGenerationOptions(f));
    if (refreshed.isErr()) {
      throw refreshed.error;
    }
    expect(
      verifyPublicMetadata({
        manifest: refreshed.value,
        reader: f.reader,
      }).isOk(),
    ).toBe(true);
    f.documents.set(
      key,
      changed.replace("run: echo initial", "run: echo unrelated"),
    );
    expect(
      verifyPublicMetadata({
        manifest: refreshed.value,
        reader: f.reader,
      }).isOk(),
    ).toBe(true);
  }, 15_000);
}

test("action input and environment mapping order does not change classification", () => {
  const workflow =
    "jobs: {check: {steps: [{uses: 'vendor/action@revision', with: {alpha: one, beta: two}, env: {FIRST: one, SECOND: two}}]}}";
  const reordered = workflow
    .replace("alpha: one, beta: two", "beta: two, alpha: one")
    .replace("FIRST: one, SECOND: two", "SECOND: two, FIRST: one");
  expect(reordered).not.toBe(workflow);
  const original = parseDocument(workflow);
  const changed = parseDocument(reordered);
  if (original.isErr()) {
    throw original.error;
  }
  if (changed.isErr()) {
    throw changed.error;
  }
  expect(changed.value.digest).toBe(original.value.digest);
});

test("reusable workflow caller inputs require review until metadata is refreshed", () => {
  const f = fixture();
  const key = "candidate:.github/workflows/ci.yml";
  const original = f.reader.read("candidate", ".github/workflows/ci.yml");
  const workflow = original.replace(
    "  reusable:\n",
    "  reusable:\n    with: {dist-tag: preview, publish: false}\n",
  );
  f.documents.set(key, workflow);
  const options = fixtureGenerationOptions(f);
  const baseline = generateClassification(options);
  if (baseline.isErr()) {
    throw baseline.error;
  }
  const changed = workflow.replace(
    "dist-tag: preview, publish: false",
    "dist-tag: stable, publish: true",
  );
  expect(changed).not.toBe(workflow);
  f.documents.set(key, changed);
  failure(
    verifyPublicMetadata({ manifest: baseline.value, reader: f.reader }),
    ".github/workflows/ci.yml/reusable",
  );
  failure(
    verifyPublicMetadata({ manifest: baseline.value, reader: f.reader }),
    ".github/ci-job-classification-decisions/",
  );
  const stale = generateClassification(options);
  expect(stale.isErr()).toBe(true);
  if (stale.isErr()) {
    expect(stale.error).toBeInstanceOf(ReviewRequiredError);
  }
  const refreshed = generateClassification(fixtureGenerationOptions(f));
  if (refreshed.isErr()) {
    throw refreshed.error;
  }
  expect(
    verifyPublicMetadata({
      manifest: refreshed.value,
      reader: f.reader,
    }).isOk(),
  ).toBe(true);
}, 15_000);

// Key census from https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax.
// Separate fixtures retain the job/step variants; future keys prove default inclusion.
const invocationKeyFixture = {
  workflow_call: {
    inputs: {
      channel: {
        type: "string",
        default: "preview",
        required: false,
        description: "Channel",
        "future-input-key": "value",
      },
    },
    secrets: {
      token: {
        required: false,
        description: "Token",
        "future-secret-key": "value",
      },
    },
    outputs: {
      artifact: {
        value: "result",
        description: "Artifact",
        "future-output-key": "value",
      },
    },
    "future-call-key": "value",
  },
  workflow_dispatch: {
    inputs: {
      channel: {
        type: "choice",
        options: ["preview", "stable"],
        default: "preview",
        required: false,
        description: "Channel",
        "future-dispatch-input-key": "value",
      },
    },
    "future-dispatch-key": "value",
  },
  "future-trigger-key": { mode: "value" },
} as const;

const classificationKeyFixtures = {
  document: [
    {
      name: "Workflow",
      "run-name": "Checks",
      on: invocationKeyFixture,
      permissions: { contents: "read" },
      env: { MODE: "check" },
      defaults: { run: { shell: "bash" } },
      concurrency: { group: "checks" },
      "cache-mode": "read-only",
      jobs: { check: { steps: [{ run: "echo initial" }] } },
      "future-document-key": { nested: "value" },
    },
  ],
  job: [
    {
      name: "Checks",
      permissions: { contents: "read" },
      needs: ["prepare"],
      if: "always()",
      "runs-on": "ubuntu-latest",
      snapshot: { "image-name": "checks" },
      environment: "staging",
      concurrency: { group: "checks" },
      "cache-mode": "read-only",
      outputs: { artifact: "result" },
      env: { MODE: "check" },
      defaults: { run: { shell: "bash", "working-directory": "src" } },
      steps: [{ run: "echo initial", env: { MODE: "check" } }],
      "timeout-minutes": 10,
      strategy: {
        matrix: { os: ["ubuntu-latest"] },
        "fail-fast": false,
        "max-parallel": 2,
      },
      "continue-on-error": false,
      container: { image: "node:24" },
      services: { cache: { image: "redis:8" } },
      "future-job-key": { nested: "value" },
    },
    { uses: "./child.yml", with: { channel: "preview" }, secrets: "inherit" },
  ],
  step: [
    {
      id: "action",
      name: "Action",
      if: "always()",
      uses: "vendor/action@revision",
      with: { mode: "check" },
      env: { MODE: "check" },
      "continue-on-error": false,
      "timeout-minutes": 5,
      "future-step-key": { nested: "value" },
    },
    {
      run: "echo initial",
      "working-directory": "src",
      shell: "bash",
      background: true,
    },
    { wait: "worker" },
    { "wait-all": true },
    { cancel: "worker" },
    {
      parallel: [{ run: "echo child", env: { MODE: "check" } }],
      id: "group",
      "future-parallel-key": "value",
    },
  ],
} as const;

for (const scope of ["document", "job", "step"] as const) {
  test(`every fixture ${scope} key is projected or explicitly excluded`, () => {
    const seen = new Set<string>();
    const digest = (definition: Record<string, unknown>) => {
      const workflows = {
        document: definition,
        job: { jobs: { check: definition } },
        step: { jobs: { check: { steps: [definition] } } },
      } as const satisfies Record<
        keyof typeof CLASSIFICATION_EXCLUSIONS,
        unknown
      >;
      const result = parseDocument(JSON.stringify(workflows[scope]));
      if (result.isErr()) {
        throw result.error;
      }
      return result.value.digest;
    };
    for (const definition of classificationKeyFixtures[scope]) {
      const baseline = digest(definition);
      for (const key of Object.keys(definition)) {
        seen.add(key);
        const withoutKey = Object.fromEntries(
          Object.entries(definition).filter(([name]) => name !== key),
        );
        const excluded = CLASSIFICATION_EXCLUSIONS[scope].some(
          (name) => name === key,
        );
        expect({ key, stable: digest(withoutKey) === baseline }).toEqual({
          key,
          stable: excluded,
        });
      }
    }
    expect(CLASSIFICATION_EXCLUSIONS[scope].every((key) => seen.has(key))).toBe(
      true,
    );
  }, 15_000);
}

for (const [before, after] of [
  [
    "on: {workflow_call: {inputs: {channel: {type: string, default: latest}}}}",
    "on: {workflow_call: {inputs: {channel: {type: string, default: next}}}}",
  ],
  ["on: pull_request", "on: pull_request_target"],
  ["future-workflow-key: preview", "future-workflow-key: stable"],
] satisfies readonly (readonly [string, string])[]) {
  test(`document configuration changes require classification refresh: ${before}`, () => {
    const f = fixture();
    const key = "candidate:.github/workflows/ci.yml";
    const workflow = `${before}\n${f.reader.read("candidate", ".github/workflows/ci.yml")}`;
    f.documents.set(key, workflow);
    const options = fixtureGenerationOptions(f);
    const baseline = generateClassification(options);
    if (baseline.isErr()) {
      throw baseline.error;
    }
    const changed = workflow.replace(before, () => after);
    expect(changed).not.toBe(workflow);
    f.documents.set(key, changed);
    failure(
      verifyPublicMetadata({ manifest: baseline.value, reader: f.reader }),
      ".github/ci-job-classification-decisions/",
    );
    const stale = generateClassification(options);
    expect(stale.isErr()).toBe(true);
    if (stale.isErr()) {
      expect(stale.error).toBeInstanceOf(ReviewRequiredError);
    }
    const refreshed = generateClassification(fixtureGenerationOptions(f));
    if (refreshed.isErr()) {
      throw refreshed.error;
    }
    expect(
      verifyPublicMetadata({
        manifest: refreshed.value,
        reader: f.reader,
      }).isOk(),
    ).toBe(true);
  }, 15_000);
}

test("every nested invocation key participates in document classification", () => {
  const mapping = v.record(v.string(), v.unknown());
  const keyPaths = (value: unknown): string[][] => {
    if (!v.is(mapping, value)) {
      return [];
    }
    return Object.entries(value).flatMap(([key, child]) => [
      [key],
      ...keyPaths(child).map((keyPath) => [key, ...keyPath]),
    ]);
  };
  const withoutKey = (value: unknown, keyPath: string[]): unknown => {
    const [head, ...tail] = keyPath;
    return Object.fromEntries(
      Object.entries(v.parse(mapping, value)).flatMap(([key, child]) => {
        if (key !== head) {
          return [[key, child]];
        }
        return tail.length ? [[key, withoutKey(child, tail)]] : [];
      }),
    );
  };
  const digest = (on: unknown) => {
    const result = parseDocument(
      JSON.stringify({ on, jobs: { check: { steps: [] } } }),
    );
    if (result.isErr()) {
      throw result.error;
    }
    return result.value.digest;
  };
  const baseline = digest(invocationKeyFixture);
  const paths = keyPaths(invocationKeyFixture);
  expect(paths.length).toBeGreaterThan(20);
  for (const keyPath of paths) {
    expect({
      keyPath,
      stable: digest(withoutKey(invocationKeyFixture, keyPath)) === baseline,
    }).toEqual({ keyPath, stable: false });
  }
}, 15_000);

test("GitHub on keys retain their string identity in canonical YAML", () => {
  const unquoted = "on: push\njobs: {check: {steps: []}}";
  const original = parseDocument(unquoted);
  const quoted = parseDocument(unquoted.replace("on:", "'on':"));
  const extraKey = parseDocument(`'true': distinct\n${unquoted}`);
  if (original.isErr()) {
    throw original.error;
  }
  if (quoted.isErr()) {
    throw quoted.error;
  }
  if (extraKey.isErr()) {
    throw extraKey.error;
  }
  expect(quoted.value.digest).toBe(original.value.digest);
  expect(extraKey.value.digest).not.toBe(original.value.digest);
});

const parsedWorkflow = (document: Record<string, unknown>) => {
  const parsed = parseDocument(JSON.stringify(document));
  if (parsed.isErr()) {
    throw parsed.error;
  }
  return parsed.value;
};

test("job digests isolate sibling edits and bind document headers", () => {
  assertProperty(
    "job digests isolate sibling edits and bind document headers",
    fc.property(
      fc.dictionary(fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/u), fc.string(), {
        maxKeys: 4,
      }),
      fc.array(fc.string(), { minLength: 2, maxLength: 5 }),
      (header, labels) => {
        const jobs = Object.fromEntries(
          labels.map((label, index) => [
            `job${index}`,
            { "runs-on": "ubuntu-latest", env: { LABEL: label }, steps: [] },
          ]),
        );
        const baseline = parsedWorkflow({ env: header, jobs });
        const changedJob = parsedWorkflow({
          env: header,
          jobs: { ...jobs, job0: { "runs-on": "windows-latest", steps: [] } },
        });
        expect(changedJob.jobs["job0"]?.digest).not.toBe(
          baseline.jobs["job0"]?.digest,
        );
        for (let index = 1; index < labels.length; index += 1) {
          expect(changedJob.jobs[`job${index}`]?.digest).toBe(
            baseline.jobs[`job${index}`]?.digest,
          );
        }
        const changedHeader = parsedWorkflow({
          env: header,
          "future-document-key": "changed",
          jobs,
        });
        for (const id of Object.keys(jobs)) {
          expect(changedHeader.jobs[id]?.digest).not.toBe(
            baseline.jobs[id]?.digest,
          );
        }
      },
    ),
    { numRuns: 30 },
  );
}, 60_000);

for (const job of [
  { permissions: { contents: "write" }, steps: [] },
  { permissions: { "id-token": "write" }, steps: [] },
  { "runs-on": ["self-hosted", "linux"], steps: [] },
  { secrets: "inherit", uses: "./child.yml" },
  { steps: [{ run: `echo ${githubExpression("secrets.TOKEN")}` }] },
  { steps: [{ run: "npm publish" }] },
  { steps: [{ run: "bun deploy" }] },
  { steps: [{ run: "bun release" }] },
]) {
  test(`privileged derived shapes require sensitive review: ${JSON.stringify(job)}`, () => {
    const parsed = parsedWorkflow({ jobs: { check: job } });
    const definition = parsed.jobs["check"];
    if (!definition) {
      throw new AdmissionError({ message: "privileged fixture job missing" });
    }
    expect(
      isPrivilegedJob({
        kind: ORDINARY,
        privileged: definition.privileged,
        shape: definition.shape,
      }),
    ).toBe(true);
  });
}

test("priority decisions are sensitive even for an unprivileged derived shape", () => {
  const parsed = parsedWorkflow({ jobs: { check: { steps: [] } } });
  const definition = parsed.jobs["check"];
  if (!definition) {
    throw new AdmissionError({ message: "priority fixture job missing" });
  }
  expect(
    isPrivilegedJob({
      kind: "priority",
      privileged: definition.privileged,
      shape: definition.shape,
    }),
  ).toBe(true);
  expect(
    isPrivilegedJob({
      kind: ORDINARY,
      privileged: definition.privileged,
      shape: definition.shape,
    }),
  ).toBe(false);
});

for (const review of ["missing", "stale"] as const) {
  test(`${review} decisions fail with the exact decision entry to paste`, () => {
    const f = fixture();
    const options = fixtureGenerationOptions(f);
    const key = "candidate:.github/workflows/ci.yml/caller";
    const decision = options.decisions[key];
    if (!decision) {
      throw new AdmissionError({ message: "review fixture decision missing" });
    }
    if (review === "missing") {
      options.decisions = Object.fromEntries(
        Object.entries(options.decisions).filter(([jobKey]) => jobKey !== key),
      );
    }
    const workflow = f.reader
      .read("candidate", ".github/workflows/ci.yml")
      .replace(
        "  caller:\n",
        "  caller:\n    permissions: {contents: write}\n",
      );
    f.documents.set("candidate:.github/workflows/ci.yml", workflow);
    const parsed = parseDocument(workflow);
    if (parsed.isErr()) {
      throw parsed.error;
    }
    const current = parsed.value.jobs["caller"];
    if (!current) {
      throw new AdmissionError({ message: "review fixture job missing" });
    }
    expect(current.digest).not.toBe(decision.approvedDigests[0]);
    const action = parseDocument(
      f.reader.read("candidate", ".github/actions/local/action.yml"),
    );
    if (action.isErr()) {
      throw action.error;
    }
    const reviewedDigest = sha256(
      JSON.stringify({
        digest: current.digest,
        dependencies: { "$/.github/actions/local": action.value.digest },
      }),
    );
    const result = generateClassification(options);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ReviewRequiredError);
      expect(result.error.message).toContain(
        `${decisionPathForKey(key)}\n${JSON.stringify(
          {
            kind:
              review === "missing"
                ? "<choose ordinary, support, or priority>"
                : decision.kind,
            qualifier:
              review === "missing"
                ? "<describe the reviewed classification>"
                : decision.qualifier,
            reviewedDigest,
          },
          null,
          2,
        )}`,
      );
      expect(result.error.message).toMatch(/sensitive/iu);
      if (result.error instanceof ReviewRequiredError) {
        expect(result.error.privilegedJobs).toEqual([key]);
      }
    }
  }, 15_000);
}

test("the CLI emits a sensitive annotation and machine output until review is updated", () => {
  const root = mkdtempSync(path.join(tmpdir(), "classification-review-"));
  try {
    mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    const workflowPath = path.join(root, ".github/workflows/ci.yml");
    const outputPath = path.join(root, "step-output");
    const key = "candidate:.github/workflows/ci.yml/publish";
    const baseline = parsedWorkflow({ jobs: { publish: { steps: [] } } });
    const changed = parsedWorkflow({
      jobs: { publish: { permissions: { contents: "write" }, steps: [] } },
    });
    const originalJob = baseline.jobs["publish"];
    const changedJob = changed.jobs["publish"];
    if (!originalJob || !changedJob) {
      throw new AdmissionError({ message: "CLI review fixture job missing" });
    }
    expect(changedJob.digest).not.toBe(originalJob.digest);
    writeFileSync(workflowPath, "jobs: {publish: {steps: []}}");
    writeFileSync(
      path.join(root, ".github/ci-job-classification-sources.json"),
      "{}",
    );
    const decision = {
      kind: ORDINARY,
      qualifier: "Reviewed checks",
      reviewedDigest: originalJob.digest,
    };
    writeDecision(root, key, decision);
    const git = (args: string[]) =>
      Bun.spawnSync(["git", "-C", root, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
    expect(git(["init", "--quiet"]).exitCode).toBe(0);
    expect(git(["add", "."]).exitCode).toBe(0);
    expect(
      git([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "baseline",
      ]).exitCode,
    ).toBe(0);
    const base = new TextDecoder()
      .decode(git(["rev-parse", "HEAD"]).stdout)
      .trim();
    writeFileSync(
      workflowPath,
      "jobs: {publish: {permissions: {contents: write}, steps: []}}",
    );
    const check = () =>
      Bun.spawnSync(
        [
          process.execPath,
          path.join(repositoryRoot, "scripts/check-ci-job-classification.ts"),
          root,
          "--base",
          base,
        ],
        {
          env: { ...process.env, GITHUB_OUTPUT: outputPath },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
    const stale = check();
    expect(stale.exitCode).toBe(1);
    expect(new TextDecoder().decode(stale.stdout)).toContain(
      `::error title=Sensitive classification change::${key}`,
    );
    expect(new TextDecoder().decode(stale.stderr)).toContain(
      "Sensitive classification change",
    );
    expect(readFileSync(outputPath, "utf-8")).toBe(
      "privileged_classification_change=true\n",
    );
    // The job now writes the repository, so the reviewer records it as
    // publication; keeping it ordinary at the new digest is refused.
    writeDecision(root, key, {
      ...decision,
      reviewedDigest: changedJob.digest,
    });
    const keptOrdinary = check();
    expect(keptOrdinary.exitCode).toBe(1);
    expect(new TextDecoder().decode(keptOrdinary.stderr)).toContain(
      "must be classified priority",
    );
    writeFileSync(outputPath, "");
    writeDecision(root, key, {
      kind: CLASSIFICATIONS[2],
      qualifier: "Reviewed publication",
      reviewedDigest: changedJob.digest,
    });
    const reviewed = check();
    expect(reviewed.exitCode).toBe(0);
    expect(new TextDecoder().decode(reviewed.stdout)).toBe(
      `::error title=Sensitive classification change::${key}\nClassified 1 workflows\n`,
    );
    expect(new TextDecoder().decode(reviewed.stderr)).toBe("");
    expect(readFileSync(outputPath, "utf-8")).toBe(
      "privileged_classification_change=true\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test("a reached document is privileged when only one of its jobs is", () => {
  const reusable = parseDocument(
    "on: {workflow_call: {}}\njobs: {release: {permissions: {contents: write}, steps: [{run: 'echo release'}]}}",
  );
  const ordinary = parseDocument(
    "on: {workflow_call: {}}\njobs: {check: {permissions: {contents: read}, steps: [{run: 'echo check'}]}}",
  );
  if (reusable.isErr() || ordinary.isErr()) {
    throw new AdmissionError({ message: "reusable fixture parse failed" });
  }
  expect(reusable.value.privileged).toBe(true);
  expect(ordinary.value.privileged).toBe(false);
});

test("a reviewed publish change in a reachable composite action stays sensitive", () => {
  const root = mkdtempSync(path.join(tmpdir(), "classification-closure-"));
  try {
    mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    mkdirSync(path.join(root, ".github/actions/local"), { recursive: true });
    const workflow =
      "jobs: {check: {steps: [{uses: './.github/actions/local'}]}}";
    const beforeAction =
      "runs: {using: composite, steps: [{run: 'echo check'}]}";
    const afterAction =
      "runs: {using: composite, steps: [{run: 'npm publish'}]}";
    const workflowPath = path.join(root, ".github/workflows/ci.yml");
    const actionPath = path.join(root, ".github/actions/local/action.yml");
    const outputPath = path.join(root, "output");
    const key = "candidate:.github/workflows/ci.yml/check";
    const digest = (action: string) => {
      const parsedCallerWorkflow = parseDocument(workflow);
      const parsedAction = parseDocument(action);
      if (parsedCallerWorkflow.isErr() || parsedAction.isErr()) {
        throw new AdmissionError({ message: "closure fixture parse failed" });
      }
      return sha256(
        JSON.stringify({
          digest: parsedCallerWorkflow.value.jobs["check"]?.digest,
          dependencies: {
            "./.github/actions/local": parsedAction.value.digest,
          },
        }),
      );
    };
    writeFileSync(workflowPath, workflow);
    writeFileSync(actionPath, beforeAction);
    writeFileSync(
      path.join(root, ".github/ci-job-classification-sources.json"),
      "{}",
    );
    writeDecision(root, key, {
      kind: ORDINARY,
      qualifier: "Reviewed",
      reviewedDigest: digest(beforeAction),
    });
    const git = (args: string[]) => Bun.spawnSync(["git", "-C", root, ...args]);
    expect(git(["init", "--quiet"]).exitCode).toBe(0);
    expect(git(["add", "."]).exitCode).toBe(0);
    expect(
      git([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "base",
      ]).exitCode,
    ).toBe(0);
    const base = new TextDecoder()
      .decode(git(["rev-parse", "HEAD"]).stdout)
      .trim();
    writeFileSync(actionPath, afterAction);
    writeDecision(root, key, {
      kind: ORDINARY,
      qualifier: "Reviewed",
      reviewedDigest: digest(afterAction),
    });
    const result = Bun.spawnSync(
      [
        process.execPath,
        path.join(repositoryRoot, "scripts/check-ci-job-classification.ts"),
        root,
        "--base",
        base,
      ],
      {
        env: { ...process.env, GITHUB_OUTPUT: outputPath },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.exitCode).toBe(0);
    expect(readFileSync(outputPath, "utf-8")).toBe(
      "privileged_classification_change=true\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test("the CLI defaults its root and base when invoked without arguments", () => {
  const root = mkdtempSync(path.join(tmpdir(), "classification-defaults-"));
  try {
    mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    const workflow = "jobs: {check: {steps: []}}";
    const parsed = parseDocument(workflow);
    if (parsed.isErr() || !parsed.value.jobs["check"]) {
      throw new AdmissionError({ message: "default CLI fixture parse failed" });
    }
    writeFileSync(path.join(root, ".github/workflows/ci.yml"), workflow);
    writeFileSync(
      path.join(root, ".github/ci-job-classification-sources.json"),
      "{}",
    );
    const key = "candidate:.github/workflows/ci.yml/check";
    writeDecision(root, key, {
      kind: ORDINARY,
      qualifier: "Reviewed",
      reviewedDigest: parsed.value.jobs["check"].digest,
    });
    const git = (args: string[]) => Bun.spawnSync(["git", "-C", root, ...args]);
    expect(git(["init", "--quiet"]).exitCode).toBe(0);
    expect(git(["add", "."]).exitCode).toBe(0);
    expect(
      git([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "base",
      ]).exitCode,
    ).toBe(0);
    expect(
      git(["update-ref", "refs/remotes/origin/main", "HEAD"]).exitCode,
    ).toBe(0);
    const result = Bun.spawnSync(
      [
        process.execPath,
        path.join(repositoryRoot, "scripts/check-ci-job-classification.ts"),
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toBe(
      "Classified 1 workflows\n",
    );

    // A check that fails for any reason reports the change as sensitive.
    writeDecision(root, "candidate:.github/workflows/ci.yml/removed", {
      kind: ORDINARY,
      qualifier: "Reviewed",
      reviewedDigest: parsed.value.jobs["check"].digest,
    });
    const outputPath = path.join(root, "output");
    const failed = Bun.spawnSync(
      [
        process.execPath,
        path.join(repositoryRoot, "scripts/check-ci-job-classification.ts"),
      ],
      {
        cwd: root,
        env: { ...process.env, GITHUB_OUTPUT: outputPath },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(failed.exitCode).toBe(1);
    expect(readFileSync(outputPath, "utf-8")).toBe(
      "privileged_classification_change=true\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

for (const scenario of [
  {
    name: "non-privileged reviewed changes do not set the sensitive flag",
    before: "jobs: {check: {env: {MODE: one}, steps: []}}",
    after: "jobs: {check: {env: {MODE: two}, steps: []}}",
    expected: false,
  },
  {
    name: "removing a privileged marker remains a sensitive change",
    before: "jobs: {check: {permissions: {contents: write}, steps: []}}",
    after: "jobs: {check: {steps: []}}",
    expected: true,
  },
] as const) {
  test(
    scenario.name,
    () => {
      const root = mkdtempSync(path.join(tmpdir(), "classification-base-"));
      try {
        mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
        const workflow = path.join(root, ".github/workflows/ci.yml");
        const sources = path.join(
          root,
          ".github/ci-job-classification-sources.json",
        );
        const output = path.join(root, "output");
        const key = "candidate:.github/workflows/ci.yml/check";
        const digest = (text: string) => {
          const parsed = parseDocument(text);
          if (parsed.isErr()) {
            throw parsed.error;
          }
          const job = parsed.value.jobs["check"];
          if (!job) {
            throw new AdmissionError({ message: "scenario job missing" });
          }
          return job.digest;
        };
        writeFileSync(workflow, scenario.before);
        writeFileSync(sources, "{}");
        writeDecision(root, key, {
          kind: ORDINARY,
          qualifier: "Reviewed",
          reviewedDigest: digest(scenario.before),
        });
        const git = (args: string[]) =>
          Bun.spawnSync(["git", "-C", root, ...args]);
        expect(git(["init", "--quiet"]).exitCode).toBe(0);
        expect(git(["add", "."]).exitCode).toBe(0);
        expect(
          git([
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "base",
          ]).exitCode,
        ).toBe(0);
        const base = new TextDecoder()
          .decode(git(["rev-parse", "HEAD"]).stdout)
          .trim();
        writeFileSync(workflow, scenario.after);
        const run = () =>
          Bun.spawnSync(
            [
              process.execPath,
              path.join(
                repositoryRoot,
                "scripts/check-ci-job-classification.ts",
              ),
              root,
              "--base",
              base,
            ],
            {
              env: { ...process.env, GITHUB_OUTPUT: output },
              stdout: "pipe",
              stderr: "pipe",
            },
          );
        const stale = run();
        expect(stale.exitCode).toBe(1);
        // A failing check reports sensitive regardless of the change.
        expect(readFileSync(output, "utf-8")).toBe(
          "privileged_classification_change=true\n",
        );
        writeDecision(root, key, {
          kind: ORDINARY,
          qualifier: "Reviewed",
          reviewedDigest: digest(scenario.after),
        });
        const result = run();
        expect(result.exitCode).toBe(0);
        expect(readFileSync(output, "utf-8")).toBe(
          `privileged_classification_change=true\nprivileged_classification_change=${scenario.expected}\n`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    10_000,
  );
}

test("downgrading a priority decision with an unchanged digest is a sensitive change", () => {
  const root = mkdtempSync(path.join(tmpdir(), "classification-kind-"));
  try {
    mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    const workflow = "jobs: {check: {steps: []}}";
    const parsed = parseDocument(workflow);
    const job = parsed.isOk() ? parsed.value.jobs["check"] : undefined;
    if (!job) {
      throw new AdmissionError({ message: "kind fixture parse failed" });
    }
    const key = "candidate:.github/workflows/ci.yml/check";
    const decide = (kind: (typeof CLASSIFICATIONS)[number]) => ({
      kind,
      qualifier: "Reviewed",
      reviewedDigest: job.digest,
    });
    writeFileSync(path.join(root, ".github/workflows/ci.yml"), workflow);
    writeFileSync(
      path.join(root, ".github/ci-job-classification-sources.json"),
      "{}",
    );
    writeDecision(root, key, decide(CLASSIFICATIONS[2]));
    const git = (args: string[]) => Bun.spawnSync(["git", "-C", root, ...args]);
    expect(git(["init", "--quiet"]).exitCode).toBe(0);
    expect(git(["add", "."]).exitCode).toBe(0);
    expect(
      git([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "base",
      ]).exitCode,
    ).toBe(0);
    const base = new TextDecoder()
      .decode(git(["rev-parse", "HEAD"]).stdout)
      .trim();
    writeDecision(root, key, decide(ORDINARY));
    const output = path.join(root, "output");
    const removedOutput = path.join(root, "removed-output");
    const result = Bun.spawnSync(
      [
        process.execPath,
        path.join(repositoryRoot, "scripts/check-ci-job-classification.ts"),
        root,
        "--base",
        base,
      ],
      {
        env: { ...process.env, GITHUB_OUTPUT: output },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.exitCode).toBe(0);
    expect(readFileSync(output, "utf-8")).toBe(
      "privileged_classification_change=true\n",
    );

    // Removing the privileged job and its decision is a sensitive change too.
    writeFileSync(
      path.join(root, ".github/workflows/ci.yml"),
      "jobs: {other: {steps: []}}",
    );
    const other = parseDocument("jobs: {other: {steps: []}}");
    const otherJob = other.isOk() ? other.value.jobs["other"] : undefined;
    if (!otherJob) {
      throw new AdmissionError({ message: "removal fixture parse failed" });
    }
    rmSync(path.join(root, decisionPathForKey(key)));
    writeDecision(root, "candidate:.github/workflows/ci.yml/other", {
      kind: ORDINARY,
      qualifier: "Reviewed",
      reviewedDigest: otherJob.digest,
    });
    const removed = Bun.spawnSync(
      [
        process.execPath,
        path.join(repositoryRoot, "scripts/check-ci-job-classification.ts"),
        root,
        "--base",
        base,
      ],
      {
        env: { ...process.env, GITHUB_OUTPUT: removedOutput },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(removed.exitCode).toBe(0);
    expect(readFileSync(removedOutput, "utf-8")).toBe(
      "privileged_classification_change=true\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test("decisions for removed jobs fail without changing sibling job digests", () => {
  const f = fixture();
  const options = fixtureGenerationOptions(f);
  const key = "candidate:.github/workflows/ci.yml";
  const original = f.reader.read("candidate", ".github/workflows/ci.yml");
  const removed = original.replace(
    / {2}caller:\n[\s\S]*?(?= {2}reusable:)/u,
    "",
  );
  expect(removed).not.toBe(original);
  f.documents.set(key, removed);
  const parsed = parseDocument(removed);
  if (parsed.isErr()) {
    throw parsed.error;
  }
  const callee = parseDocument(
    f.reader.read(
      "public-supplier@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ".github/workflows/reusable.yml",
    ),
  );
  if (callee.isErr()) {
    throw callee.error;
  }
  const reusableDecision = options.decisions[`${key}/reusable`];
  if (!reusableDecision) {
    throw new AdmissionError({ message: "reusable decision missing" });
  }
  expect([
    sha256(
      JSON.stringify({
        digest: parsed.value.jobs["reusable"]?.digest,
        dependencies: {
          "vendor/shared/.github/workflows/reusable.yml@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":
            callee.value.digest,
        },
      }),
    ),
  ]).toEqual(reusableDecision.approvedDigests);
  const result = generateClassification(options);
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error).toBeInstanceOf(AdmissionError);
    expect(result.error.message).toContain(
      `Decisions for removed jobs: ${key}/caller`,
    );
  }
}, 15_000);

import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import {
  CLASSIFICATIONS,
  sha256,
} from "../../../scripts/ci-job-classification/classification-values";
import {
  PUBLIC_METADATA,
  createCandidateMetadataReader,
  verifyPublicMetadata,
} from "../../../scripts/ci-job-classification/public-metadata";
import type {
  PublicMetadata,
  MetadataReader,
} from "../../../scripts/ci-job-classification/public-metadata";
import {
  AdmissionError,
  parseDocument,
} from "../../../scripts/ci-job-classification/yaml";

const ORDINARY = CLASSIFICATIONS[0];
const repositoryRoot = path.resolve(import.meta.dir, "../../..");
const githubExpression = (expression: string) =>
  ["$", "{{ ", expression, " }}"].join("");

test("committed classifications cover the repository and its pinned metadata callees", () => {
  const manifest = v.parse(
    PUBLIC_METADATA,
    JSON.parse(
      readFileSync(
        path.join(repositoryRoot, ".github/ci-job-classification.json"),
        "utf-8",
      ),
    ),
  );
  const snapshots = v.parse(
    v.record(
      v.string(),
      v.object({
        revision: v.string(),
        documents: v.record(v.string(), v.string()),
      }),
    ),
    JSON.parse(
      readFileSync(
        path.join(repositoryRoot, ".github/ci-job-classification-sources.json"),
        "utf-8",
      ),
    ),
  );
  const result = verifyPublicMetadata({
    manifest,
    reader: {
      workflows: () => [
        ...new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync({
          cwd: repositoryRoot,
        }),
      ],
      read: (repository, file) => {
        if (repository === "candidate") {
          return readFileSync(path.join(repositoryRoot, file), "utf-8");
        }
        const text = snapshots[repository]?.documents[file];
        if (text === undefined) {
          throw new AdmissionError({
            message: "Pinned metadata fixture missing",
          });
        }
        return text;
      },
    },
  });
  expect(result.isOk()).toBe(true);
  if (result.isErr()) {
    throw result.error;
  }
  expect(result.value.workflowCount).toBe(manifest.workflows.length);
  expect(result.value.classifications.priority).toBeGreaterThan(0);
});

test("the policy check invokes classification after a successful install", () => {
  const workflow: unknown = Bun.YAML.parse(
    readFileSync(
      path.join(repositoryRoot, ".github/workflows/ci.yml"),
      "utf-8",
    ),
  );
  const policy = v.parse(
    v.object({
      jobs: v.object({
        "ci-checks-policy": v.object({
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
  ).jobs["ci-checks-policy"].steps;
  const install = policy.findIndex((step) => step.id === "install");
  const check = policy.findIndex(
    (step) =>
      step.run ===
      "bun .ci-job-classification/scripts/check-ci-job-classification.ts .ci-job-classification",
  );
  expect(install).toBeGreaterThanOrEqual(0);
  expect(check).toBeGreaterThan(install);
  const checkout = policy.findIndex(
    (step) => step.with?.["path"] === ".ci-job-classification",
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
  for (const index of [checkout, check]) {
    const step = policy.at(index);
    expect(step?.if).toBe(
      githubExpression("!cancelled() && steps.install.outcome == 'success'"),
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
    file: string;
    text: string;
    references: string[];
    edges: Record<string, string>;
  };
  const source = ({
    id,
    repository,
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
      path: file,
      digest: sha256(text),
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
        file: ".github/actions/local/action.yml",
        text: action,
        references: ["$/.github/actions/local"],
        edges: {},
      }),
      source({
        id: "callee",
        repository: "public-supplier@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        file: ".github/workflows/reusable.yml",
        text: callee,
        references: [
          "vendor/shared/.github/workflows/reusable.yml@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ],
        edges: {},
      }),
    ],
  };
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
    "callee job classification totality",
  );
  f.documents.set(
    "public-supplier@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:.github/workflows/reusable.yml",
    "jobs: {hidden: {steps: [{run: 'publish'}]}}",
  );
  failure(verifyPublicMetadata(f), "metadata digest changed");
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
    "source-relative metadata path mismatch",
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
    "workflow classification totality",
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
      { stdout: "pipe", stderr: "pipe" },
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

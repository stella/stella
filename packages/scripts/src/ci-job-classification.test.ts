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
  generateClassification,
  readClassificationInputs,
} from "../../../scripts/ci-job-classification/generate";
import {
  PUBLIC_METADATA,
  createCandidateMetadataReader,
  verifyPublicMetadata,
} from "../../../scripts/ci-job-classification/public-metadata";
import type {
  PublicMetadata,
  MetadataReader,
} from "../../../scripts/ci-job-classification/public-metadata";
import { parseRemoteReference } from "../../../scripts/ci-job-classification/references";
import type { MetadataOrigin } from "../../../scripts/ci-job-classification/references";
import {
  AdmissionError,
  parseDocument,
} from "../../../scripts/ci-job-classification/yaml";

const ORDINARY = CLASSIFICATIONS[0];
const repositoryRoot = path.resolve(import.meta.dir, "../../..");
const githubExpression = (expression: string) =>
  ["$", "{{ ", expression, " }}"].join("");

test("committed classifications cover the repository and its pinned metadata callees", () => {
  const { manifest, decisions, reader } =
    readClassificationInputs(repositoryRoot);
  expect(fixtureDecisions(manifest)).toEqual(decisions);
  const result = verifyPublicMetadata({ manifest, reader });
  expect(result.isOk()).toBe(true);
  if (result.isErr()) {
    throw result.error;
  }
  expect(result.value.workflowCount).toBe(manifest.workflows.length);
  expect(result.value.classifications.priority).toBeGreaterThan(0);
  // Parses every reachable workflow and action document in a child process.
}, 60_000);

test("committed classifications declare every local action", () => {
  const manifest = v.parse(
    PUBLIC_METADATA,
    JSON.parse(
      readFileSync(
        path.join(repositoryRoot, ".github/ci-job-classification.json"),
        "utf-8",
      ),
    ),
  );
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
      "trap 'rm -rf .workflow-tooling' EXIT\nbun .workflow-tooling/scripts/check-ci-job-classification.ts .workflow-tooling\n",
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
  for (const index of [checkout, check]) {
    const step = policy.at(index);
    expect(step?.if).toBe(
      githubExpression(
        "!cancelled() && steps.install.outcome == 'success' && (needs.ci-plan.outputs.package_checks_required == 'true')",
      ),
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
      "local reusable workflow metadata path or repository mismatch",
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

const fixtureDecisions = (manifest: PublicMetadata) =>
  Object.fromEntries(
    manifest.nodes.flatMap((node) =>
      node.type === "metadata"
        ? node.jobs.map((job) => [
            `${node.repository}:${node.path}/${job.id}`,
            { kind: job.kind, qualifier: job.qualifier },
          ])
        : [],
    ),
  );

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
      "bun scripts/check-ci-job-classification.ts --write",
    );
  });
}

test("new jobs remain unclassified even when refreshing generated metadata", () => {
  const f = fixture();
  f.documents.set(
    "candidate:.github/workflows/ci.yml",
    `${f.reader.read("candidate", ".github/workflows/ci.yml")}  added:\n    steps: []\n`,
  );
  const result = generateClassification({
    ...f,
    decisions: fixtureDecisions(f.manifest),
    localActionPath: (directory) => `${directory}/action.yml`,
  });
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toContain(
      "Unclassified jobs: candidate:.github/workflows/ci.yml/added",
    );
    expect(result.error.message).toContain(
      "bun scripts/check-ci-job-classification.ts --write",
    );
  }
});

test("classification generation reaches a fixed point and preserves human decisions", () => {
  const f = fixture();
  const decisions = fixtureDecisions(f.manifest);
  const options = {
    ...f,
    decisions,
    localActionPath: (directory: string) => `${directory}/action.yml`,
  };
  const first = generateClassification(options);
  if (first.isErr()) {
    throw first.error;
  }
  const second = generateClassification({ ...options, manifest: first.value });
  if (second.isErr()) {
    throw second.error;
  }
  expect(JSON.stringify(second.value)).toBe(JSON.stringify(first.value));
  expect(fixtureDecisions(second.value)).toEqual(decisions);
});

test("real ci.yml classification is stable across comments, timeouts, step names and cache keys", () => {
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
    original.replace(/key: [^\n]+/u, "key: unrelated-cache-key"),
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
  ]) {
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

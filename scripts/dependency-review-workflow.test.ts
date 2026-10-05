import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Script } from "node:vm";
import * as v from "valibot";

import { rejectionOf } from "@stll/property-testing/rejection";

const workflow = v.parse(
  v.looseObject({
    name: v.string(),
    on: v.record(v.string(), v.unknown()),
    jobs: v.record(
      v.string(),
      v.looseObject({
        if: v.optional(v.string()),
        steps: v.array(
          v.looseObject({
            id: v.optional(v.string()),
            name: v.optional(v.string()),
            uses: v.optional(v.string()),
            if: v.optional(v.string()),
            run: v.optional(v.string()),
            with: v.optional(v.record(v.string(), v.unknown())),
          }),
        ),
      }),
    ),
  }),
  Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/dependency-review.yml", import.meta.url),
      "utf-8",
    ),
  ),
);
const job = workflow.jobs["dependency-review"];
if (!job) {
  throw new TypeError("Missing required dependency-review job");
}
const selectorStep = job.steps.find((step) => step.id === "changes");
const actionStep = job.steps.find((step) => step.id === "actions");
if (!selectorStep || !actionStep) {
  throw new TypeError("Missing dependency selector steps");
}
const selectorSource = v.parse(v.string(), selectorStep.with?.["script"]);
const actionSource = v.parse(v.string(), actionStep.run);
const referencesStart = actionSource.indexOf("const references =");
const referencesEnd = actionSource.indexOf("const snapshots =");
if (referencesStart === -1 || referencesEnd <= referencesStart) {
  throw new TypeError("Missing workflow YAML reference comparison");
}
const referenceScript = new Script(
  `(() => { ${actionSource.slice(referencesStart, referencesEnd)}; return references(source); })()`,
);
const references = (source: string) =>
  v.parse(
    v.array(v.string()),
    referenceScript.runInNewContext({ Bun, source }),
  );
const MERGE_BASE = "merge-base-fixture";
const BEFORE_WORKFLOW =
  "jobs:\n  build:\n    steps:\n      - uses: example/action@old\n";
const AFTER_WORKFLOW =
  "jobs:\n  build:\n    steps:\n      - uses: example/action@new\n";

type ChangedFile = {
  filename: string;
  previous_filename?: string;
  status: "modified" | "added" | "removed" | "renamed";
};
type SelectorOptions = {
  event?: "pull_request" | "merge_group";
  draft?: boolean;
  files?: ChangedFile[];
  comparison?: unknown;
  payload?: unknown;
  contents?: Record<string, string>;
  contentResponse?: unknown;
  failure?: "compare" | "content";
};

const selector = ({
  event = "pull_request",
  draft = false,
  files = [],
  comparison,
  payload,
  contents = {},
  contentResponse,
  failure,
}: SelectorOptions = {}) => {
  const outputs: Record<string, string> = {};
  const writes = new Map<string, string>();
  const summaries: string[] = [];
  const comparisons: Record<string, unknown>[] = [];
  const contentCalls: Record<string, unknown>[] = [];
  const base = event === "pull_request" ? "pr-base" : "queue-base";
  const head = event === "pull_request" ? "pr-head" : "queue-head";
  const available: Record<string, string | undefined> = {
    [`${MERGE_BASE}:package.json`]: '{"packageManager":"bun@1.4.1"}',
    ...contents,
  };
  const summary = {
    addRaw: (message: string) => {
      summaries.push(message);
      return summary;
    },
    write: async () => {},
  };
  const execute = async () => {
    await new Script(`(async () => { ${selectorSource} })()`).runInNewContext({
      Buffer,
      context: {
        eventName: event,
        repo: { owner: "fixture-owner", repo: "fixture-repository" },
        payload:
          payload ??
          (event === "pull_request"
            ? {
                pull_request: {
                  draft,
                  base: { sha: base },
                  head: { sha: head },
                },
              }
            : { merge_group: { base_sha: base, head_sha: head } }),
      },
      github: {
        rest: {
          repos: {
            compareCommitsWithBasehead: async (
              options: Record<string, unknown>,
            ) => {
              comparisons.push(options);
              if (failure === "compare") {
                throw new Error("Compare API unavailable");
              }
              return {
                data: comparison ?? {
                  files,
                  merge_base_commit: { sha: MERGE_BASE },
                },
              };
            },
            getContent: async (options: Record<string, unknown>) => {
              contentCalls.push(options);
              if (failure === "content") {
                throw new Error("Content API unavailable");
              }
              if (contentResponse !== undefined) {
                return { data: contentResponse };
              }
              const key = `${String(options["ref"])}:${String(options["path"])}`;
              const content = available[key];
              if (content === undefined) {
                throw new Error(`Unexpected content request: ${key}`);
              }
              return {
                data: {
                  type: "file",
                  encoding: "base64",
                  content: Buffer.from(content).toString("base64"),
                },
              };
            },
          },
        },
      },
      core: {
        setOutput: (name: string, value: string) => {
          outputs[name] = value;
        },
        summary,
      },
      process: { env: { RUNNER_TEMP: "/runner/temp" } },
      require: (name: string) => {
        if (name === "node:path") {
          return path;
        }
        if (name === "node:fs") {
          return {
            mkdtempSync: () => "/runner/temp/dependency-review-fixture",
            writeFileSync: (file: string, value: string) => {
              writes.set(file, value);
            },
          };
        }
        throw new TypeError(`Unexpected workflow module: ${name}`);
      },
    });
  };
  const snapshots = () => {
    const input = outputs["input"];
    if (!input) {
      throw new TypeError("Missing workflow snapshot output");
    }
    const source = writes.get(input);
    if (!source) {
      throw new TypeError("Missing workflow snapshot file");
    }
    return v.parse(
      v.array(v.object({ before: v.string(), after: v.string() })),
      JSON.parse(source),
    );
  };
  return {
    execute,
    outputs,
    comparisons,
    contentCalls,
    summaries,
    writes,
    snapshots,
    base,
    head,
  };
};

describe("required dependency review workflow boundary", () => {
  test("keeps one required job present for PR and merge-group events without paths or draft filtering", () => {
    expect(workflow.name).toBe("Dependency Review");
    expect(workflow.on).toEqual({
      pull_request: {
        types: ["opened", "synchronize", "reopened", "ready_for_review"],
      },
      merge_group: { types: ["checks_requested"] },
    });
    expect(Object.keys(workflow.jobs)).toEqual(["dependency-review"]);
    expect(job.if).toBeUndefined();
    expect(job["name"] ?? "dependency-review").toBe("dependency-review");
    expect(selectorStep.if).toBeUndefined();
  });

  test("conditions setup and trusted checkout/review on actual selector outputs within the same job", () => {
    const setup = job.steps.find((step) =>
      step.uses?.startsWith("oven-sh/setup-bun@"),
    );
    const checkout = job.steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    const review = job.steps.find((step) =>
      step.uses?.startsWith("actions/dependency-review-action@"),
    );
    if (!setup || !checkout || !review) {
      throw new TypeError("Missing dependency review execution steps");
    }
    expect(setup.if).toBe("steps.changes.outputs.workflows == 'true'");
    expect(actionStep.if).toBe(setup.if);
    expect(setup.with?.["bun-version-file"]).toBe(
      `\${{ steps.changes.outputs.manifest }}`,
    );
    expect(setup.with?.["no-cache"]).toBe(true);
    const reviewCondition =
      "steps.changes.outputs.required == 'true' || steps.actions.outputs.required == 'true'";
    expect(checkout.if).toBe(reviewCondition);
    expect(review.if).toBe(reviewCondition);
    expect(checkout.with?.["persist-credentials"]).toBe(false);
    expect(review.with?.["base-ref"]).toBe(
      `\${{ github.event.merge_group.base_sha || '' }}`,
    );
    expect(review.with?.["head-ref"]).toBe(
      `\${{ github.event.merge_group.head_sha || '' }}`,
    );
    expect(job.steps.indexOf(selectorStep)).toBeLessThan(
      job.steps.indexOf(checkout),
    );
  });
});

describe("dependency selector comparison scope", () => {
  test.each([
    { event: "pull_request", draft: false },
    { event: "pull_request", draft: true },
    { event: "merge_group", draft: false },
  ] as const)(
    "compares exact event refs and succeeds as a no-op for source changes: %j",
    async (options) => {
      const run = selector({
        ...options,
        files: [{ filename: "apps/web/src/example.ts", status: "modified" }],
      });
      await run.execute();
      expect(run.comparisons).toEqual([
        {
          owner: "fixture-owner",
          repo: "fixture-repository",
          basehead: `${run.base}...${run.head}`,
          per_page: 1,
        },
      ]);
      expect(run.outputs).toEqual({ required: "false", workflows: "false" });
      expect(run.contentCalls).toEqual([]);
      expect(run.summaries).toHaveLength(1);
      expect(run.summaries.join("\n")).toContain("no-op");
    },
  );

  test.each([
    "package.json",
    "packages/example/package.json",
    "bun.lock",
    "apps/desktop/Cargo.toml",
    "Cargo.lock",
    "apps/worker/pyproject.toml",
    "uv.lock",
    "apps/desktop/dmg/requirements.txt",
    "apps/desktop/dmg/requirements.in",
    "apps/worker/requirements-dev.txt",
  ])(
    "requires review for dependency input %s in drafts and merge groups",
    async (filename) => {
      for (const event of ["pull_request", "merge_group"] as const) {
        const run = selector({
          event,
          draft: true,
          files: [{ filename, status: "modified" }],
        });
        await run.execute();
        expect(run.outputs["required"]).toBe("true");
        expect(run.contentCalls).toEqual([]);
        expect(run.summaries).toEqual([]);
      }
    },
  );

  test.each([
    "apps/worker/requirements.ts",
    "apps/worker/requirements.txt.bak",
  ])(
    "does not treat nondependency lookalike %s as a manifest",
    async (filename) => {
      const run = selector({ files: [{ filename, status: "modified" }] });
      await run.execute();
      expect(run.outputs).toEqual({ required: "false", workflows: "false" });
      expect(run.summaries).toHaveLength(1);
    },
  );

  test("covers every tracked dependency input family rather than maintaining a manifest path allowlist", async () => {
    const result = Bun.spawnSync({
      cmd: [
        "git",
        "ls-files",
        "-z",
        "--",
        ":(glob)**/package.json",
        ":(glob)**/bun.lock",
        ":(glob)**/Cargo.toml",
        ":(glob)**/Cargo.lock",
        ":(glob)**/pyproject.toml",
        ":(glob)**/uv.lock",
        ":(glob)**/requirements*.txt",
        ":(glob)**/requirements*.in",
      ],
      cwd: path.resolve(import.meta.dir, ".."),
    });
    expect(result.exitCode).toBe(0);
    const manifests = result.stdout.toString().split("\0").filter(Boolean);
    expect(manifests.length).toBeGreaterThan(0);
    for (const filename of manifests) {
      const run = selector({ files: [{ filename, status: "modified" }] });
      await run.execute();
      expect(run.outputs["required"]).toBe("true");
    }
  });

  test("tracks a renamed manifest by its old path rather than only the new name", async () => {
    const run = selector({
      files: [
        {
          filename: "archive/previous-manifest.txt",
          previous_filename: "packages/example/package.json",
          status: "renamed",
        },
      ],
    });
    await run.execute();
    expect(run.outputs["required"]).toBe("true");
    expect(run.contentCalls).toEqual([]);
  });

  test.each([299, 300])(
    "treats %i returned source files conservatively at the API cap",
    async (count) => {
      const run = selector({
        files: Array.from({ length: count }, (_, index) => ({
          filename: `source/file-${index}.ts`,
          status: "modified",
        })),
      });
      await run.execute();
      expect(run.outputs["required"]).toBe(String(count >= 300));
      expect(run.summaries).toHaveLength(count >= 300 ? 0 : 1);
      expect(run.contentCalls).toEqual([]);
    },
  );

  test.each([
    { payload: {}, error: "Missing dependency comparison refs" },
    { comparison: {}, error: "Missing dependency comparison files" },
    { failure: "compare", error: "Compare API unavailable" },
  ] as const)(
    "fails without declaring a successful no-op when comparison is unavailable: %j",
    async ({ error, ...options }) => {
      const run = selector(options);
      expect(String(await rejectionOf(run.execute()))).toContain(error);
      expect(run.outputs["required"]).toBeUndefined();
      expect(run.summaries).toEqual([]);
    },
  );
});

describe("workflow dependency snapshots", () => {
  test.each(["pull_request", "merge_group"] as const)(
    "reads the merge-base and event head for modified workflows on %s",
    async (event) => {
      const run = selector({
        event,
        files: [
          { filename: ".github/workflows/example.yml", status: "modified" },
        ],
        contents: {
          [`${MERGE_BASE}:.github/workflows/example.yml`]: BEFORE_WORKFLOW,
          [`${event === "pull_request" ? "pr-head" : "queue-head"}:.github/workflows/example.yml`]:
            AFTER_WORKFLOW,
        },
      });
      await run.execute();
      expect(run.snapshots()).toEqual([
        { before: BEFORE_WORKFLOW, after: AFTER_WORKFLOW },
      ]);
      expect(
        run.contentCalls.map(({ path: filename, ref }) => ({
          path: filename,
          ref,
        })),
      ).toEqual([
        { path: ".github/workflows/example.yml", ref: MERGE_BASE },
        { path: ".github/workflows/example.yml", ref: run.head },
        { path: "package.json", ref: MERGE_BASE },
      ]);
      expect(run.outputs["required"]).toBe("false");
      expect(run.outputs["workflows"]).toBe("true");
      expect(run.writes.get(run.outputs["manifest"] ?? "")).toBe(
        '{"packageManager":"bun@1.4.1"}',
      );
    },
  );

  test.each([
    {
      status: "added",
      filename: ".github/workflows/new.yaml",
      before: "",
      after: AFTER_WORKFLOW,
    },
    {
      status: "removed",
      filename: ".github/workflows/old.yml",
      before: BEFORE_WORKFLOW,
      after: "",
    },
    {
      status: "renamed",
      filename: ".github/workflows/new.yml",
      previous_filename: ".github/workflows/old.yml",
      before: BEFORE_WORKFLOW,
      after: AFTER_WORKFLOW,
    },
    {
      status: "renamed",
      filename: "archive/workflow.txt",
      previous_filename: ".github/workflows/old.yml",
      before: BEFORE_WORKFLOW,
      after: "",
    },
    {
      status: "renamed",
      filename: ".github/workflows/new.yml",
      previous_filename: "archive/workflow.txt",
      before: "",
      after: AFTER_WORKFLOW,
    },
  ] as const)(
    "compares only existing workflow sides for %j",
    async ({ before, after, ...file }) => {
      const beforePath =
        "previous_filename" in file ? file.previous_filename : file.filename;
      const run = selector({
        files: [file],
        contents: {
          [`${MERGE_BASE}:${beforePath}`]: BEFORE_WORKFLOW,
          [`pr-head:${file.filename}`]: AFTER_WORKFLOW,
        },
      });
      await run.execute();
      expect(run.snapshots()).toEqual([{ before, after }]);
      expect(run.contentCalls).toHaveLength(
        1 + Number(before !== "") + Number(after !== ""),
      );
      expect(
        JSON.stringify(references(before)) ===
          JSON.stringify(references(after)),
      ).toBe(false);
    },
  );

  test.each([
    { contentResponse: [], error: "Cannot read dependency review input" },
    {
      contentResponse: { type: "dir", encoding: "base64" },
      error: "Cannot read dependency review input",
    },
    {
      contentResponse: { type: "file", encoding: "none" },
      error: "Cannot read dependency review input",
    },
    { failure: "content", error: "Content API unavailable" },
  ] as const)(
    "propagates unavailable or truncated workflow content: %j",
    async ({ error, ...options }) => {
      const run = selector({
        ...options,
        files: [
          { filename: ".github/workflows/example.yml", status: "modified" },
        ],
      });
      expect(String(await rejectionOf(run.execute()))).toContain(error);
      expect(run.outputs["input"]).toBeUndefined();
      expect(run.summaries).toEqual([]);
    },
  );
});

describe("composite action dependency snapshots", () => {
  const before =
    "runs: { using: composite, steps: [{ uses: 'example/action@old' }] }\n";
  const after =
    "runs: { using: composite, steps: [{ uses: 'example/action@new' }] }\n";
  for (const filename of [
    ".github/actions/example/action.yml",
    ".github/actions/nested/example/action.yaml",
    "tools/example/action.yml",
    "action.yaml",
  ]) {
    test.each(["modified", "added", "removed", "renamed"] as const)(
      `compares composite references in ${filename} for %s`,
      async (status) => {
        const previous_filename = "archive/example.txt";
        const run = selector({
          files: [
            {
              filename,
              status,
              ...(status === "renamed" ? { previous_filename } : {}),
            },
          ],
          contents: {
            [`${MERGE_BASE}:${filename}`]: before,
            [`pr-head:${filename}`]: after,
          },
        });
        await run.execute();
        const snapshots = run.snapshots();
        expect(run.outputs["workflows"]).toBe("true");
        expect(snapshots).toEqual([
          {
            before: status === "added" || status === "renamed" ? "" : before,
            after: status === "removed" ? "" : after,
          },
        ]);
        expect(
          snapshots.some(
            (snapshot) =>
              JSON.stringify(references(snapshot.before)) !==
              JSON.stringify(references(snapshot.after)),
          ),
        ).toBe(true);
      },
    );
  }
  test("compares unchanged composite references as a no-op and rejects invalid references", () => {
    expect(references(before)).toEqual(["example/action@old"]);
    expect(references(`${before}# uses: ignored/action@fake\n`)).toEqual(
      references(before),
    );
    expect(() =>
      references("runs: { using: composite, steps: [{ uses: 42 }] }"),
    ).toThrow("Invalid workflow action reference");
  });
});

describe("parsed workflow action dependencies", () => {
  test.each([
    "jobs:\n  build:\n    steps:\n      - uses: example/action@old\n",
    "jobs: { build: { steps: [ { uses: 'example/action@old' } ] } }\n",
    'jobs:\n  build:\n    steps:\n      - uses:\n          "example/action@old"\n',
    "jobs:\n  build:\n    steps:\n      - uses: |-\n          example/action@old\n",
    "jobs:\n  build:\n    steps:\n      - uses: >-\n          example/action@old\n",
    "jobs:\n  build:\n    steps:\n      - uses: example/action@old # comment\n      - run: \"echo 'uses: untrusted/action@fake'\"\n# uses: ignored/action@comment\n",
  ])(
    "parses equivalent YAML syntax as the same dependency set: %s",
    (source) => {
      expect(references(source)).toEqual(["example/action@old"]);
    },
  );

  test("includes reusable jobs, deduplicates uses, and ignores reference ordering", () => {
    const before =
      "jobs:\n  reusable:\n    uses: example/repo/.github/workflows/build.yml@v1\n  local:\n    steps:\n      - uses: example/b@v1\n      - uses: example/a@v1\n      - uses: example/b@v1\n";
    const after =
      "jobs:\n  local:\n    steps:\n      - uses: example/a@v1\n      - uses: example/b@v1\n  renamed:\n    uses: example/repo/.github/workflows/build.yml@v1\n";
    expect(references(before)).toEqual([
      "example/a@v1",
      "example/b@v1",
      "example/repo/.github/workflows/build.yml@v1",
    ]);
    expect(references(after)).toEqual(references(before));
  });

  test("rejects malformed YAML and nonstring dependency references instead of becoming a no-op", () => {
    expect(() => references("jobs: [")).toThrow(
      /YAML|yaml|parse|Parser|Unexpected|unexpected/u,
    );
    expect(() =>
      references("jobs:\n  build:\n    steps:\n      - uses: 42\n"),
    ).toThrow("Invalid workflow action reference");
    expect(() => references("jobs:\n  reusable:\n    uses: false\n")).toThrow(
      "Invalid workflow action reference",
    );
  });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const executeActionComparison = (
  snapshots: readonly { before: string; after: string }[],
) => {
  const root = mkdtempSync(path.join(tmpdir(), "dependency-review-workflow-"));
  roots.push(root);
  const input = path.join(root, "snapshots.json");
  const output = path.join(root, "output.txt");
  const summary = path.join(root, "summary.md");
  writeFileSync(input, JSON.stringify(snapshots));
  writeFileSync(output, "existing=preserved\n");
  writeFileSync(summary, "Existing summary\n");
  const result = Bun.spawnSync({
    cmd: ["bash", "-c", actionSource],
    env: {
      ...process.env,
      WORKFLOW_INPUT: input,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
    },
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    output: readFileSync(output, "utf-8"),
    summary: readFileSync(summary, "utf-8"),
  };
};

describe("real Bun action comparison output", () => {
  test.each([
    { snapshots: [], required: false },
    {
      snapshots: [{ before: BEFORE_WORKFLOW, after: BEFORE_WORKFLOW }],
      required: false,
    },
    {
      snapshots: [
        {
          before: BEFORE_WORKFLOW,
          after:
            "jobs: { build: { steps: [{ uses: 'example/action@old' }] } }\n",
        },
      ],
      required: false,
    },
    {
      snapshots: [{ before: BEFORE_WORKFLOW, after: AFTER_WORKFLOW }],
      required: true,
    },
    { snapshots: [{ before: "", after: AFTER_WORKFLOW }], required: true },
    { snapshots: [{ before: BEFORE_WORKFLOW, after: "" }], required: true },
    {
      snapshots: [
        { before: BEFORE_WORKFLOW, after: BEFORE_WORKFLOW },
        { before: BEFORE_WORKFLOW, after: AFTER_WORKFLOW },
      ],
      required: true,
    },
    {
      snapshots: [
        {
          before: "jobs: {}\n",
          after:
            "jobs:\n  reusable:\n    uses: example/repo/.github/workflows/build.yml@v1\n",
        },
      ],
      required: true,
    },
  ])(
    "appends the actual decision and corresponding summary: %j",
    ({ snapshots, required }) => {
      const result = executeActionComparison(snapshots);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.output).toBe(`existing=preserved\nrequired=${required}\n`);
      expect(result.summary).toBe(
        `Existing summary\n${
          required
            ? "Workflow action dependencies changed; running review.\n"
            : "Workflow action dependencies unchanged; review is a no-op.\n"
        }`,
      );
    },
  );

  test("fails before emitting a successful no-op for invalid workflow references", () => {
    const result = executeActionComparison([
      {
        before: BEFORE_WORKFLOW,
        after: "jobs:\n  build:\n    steps:\n      - uses: 42\n",
      },
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid workflow action reference");
    expect(result.output).toBe("existing=preserved\n");
    expect(result.summary).toBe("Existing summary\n");
  });
});

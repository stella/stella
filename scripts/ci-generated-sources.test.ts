import { panic } from "better-result";
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as v from "valibot";

import { CI_GENERATION_COMMANDS } from "./generated-files";

const stepSchema = v.looseObject({
  name: v.string(),
  id: v.optional(v.string()),
  if: v.optional(v.string()),
  uses: v.optional(v.string()),
  run: v.optional(v.string()),
  with: v.optional(v.record(v.string(), v.unknown())),
  env: v.optional(v.record(v.string(), v.string())),
  "continue-on-error": v.optional(v.unknown()),
});
const workflowSchema = v.object({
  jobs: v.record(
    v.string(),
    v.looseObject({
      needs: v.optional(v.union([v.string(), v.array(v.string())])),
      env: v.optional(v.record(v.string(), v.string())),
      outputs: v.optional(v.record(v.string(), v.string())),
      steps: v.array(stepSchema),
    }),
  ),
});
// Reusable jobs have no steps, so retain them while parsing their metadata.
const rawWorkflow = Bun.YAML.parse(
  readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf-8",
  ),
);
const parsed = v.parse(
  v.object({
    jobs: v.record(
      v.string(),
      v.looseObject({ steps: v.optional(v.array(stepSchema)) }),
    ),
  }),
  rawWorkflow,
);
const workflow = v.parse(workflowSchema, {
  jobs: Object.fromEntries(
    Object.entries(parsed.jobs).map(([id, job]) => [
      id,
      { ...job, steps: job.steps ?? [] },
    ]),
  ),
});
type Workflow = v.InferOutput<typeof workflowSchema>;
const consumerIds = (source: Workflow) =>
  Object.keys(source.jobs).filter(
    (id) =>
      id.startsWith("ci-checks-") ||
      id.startsWith("code-quality-") ||
      id === "typecheck-baseline",
  );
const manifest = `\${{ github.workspace }}/.cache/ci-generated-sources/manifest.json`;
const artifact = `generated-sources-\${{ needs.generated-sources.outputs.input_hash }}`;
const producedHash = `\${{ steps.generate.outputs.input_hash || steps.cached.outputs.input_hash }}`;
const restoreCommand =
  'bun scripts/ci-generated-sources.ts restore "$RUNNER_TEMP/generated-sources"';
const oldPreparation = new Set([
  "Generate web sources",
  "Generate web route tree",
  "Generate web compiler sources",
  "Generate types",
]);

// A commit-keyed cache hit skips every generator step; a miss runs them all.
const producerGate = "steps.cache.outputs.cache-hit != 'true'";
const producerSteps = [
  "Setup Bun",
  "Install generated source dependencies",
  "Prepare local check environment",
  "Produce generated sources",
  "Save generated sources",
];

// The producer starts beside the plan rather than after it, so only its
// consumers wait for generation. A failed producer skips its consumers and
// fails the result gate, which requires it in every run.
const assertProducer = (source: Workflow) => {
  const producer = source.jobs["generated-sources"];
  expect(producer, "generated producer").toBeDefined();
  expect(producer?.needs, "producer starts with the plan").toBeUndefined();
  expect(producer?.outputs?.["input_hash"]).toBe(producedHash);
  const steps = producer?.steps ?? [];
  const identity = steps.find(({ id }) => id === "identity");
  expect(identity?.run).toContain("$(git rev-parse HEAD)");
  const cacheIndex = steps.findIndex(({ id }) => id === "cache");
  const restored = steps.at(cacheIndex);
  expect(restored?.uses).toMatch(/^actions\/cache\/restore@[0-9a-f]{40}$/u);
  expect(restored?.with, "exact commit key only").toEqual({
    path: `\${{ runner.temp }}/generated-sources`,
    key: `\${{ steps.identity.outputs.key }}`,
  });
  const reuse = steps.find(({ id }) => id === "cached");
  expect(reuse?.if).toBe("steps.cache.outputs.cache-hit == 'true'");
  expect(reuse?.run, "reuse proves the commit").toContain(
    '"$source_sha" != "$(git rev-parse HEAD)"',
  );
  const indices = producerSteps.map((name) =>
    steps.findIndex((step) => step.name === name),
  );
  expect(
    indices.every(
      (index, position) => index > (indices[position - 1] ?? cacheIndex),
    ),
    "producer steps run in order after their gate",
  ).toBe(true);
  for (const index of indices) {
    expect(steps.at(index)?.if, steps.at(index)?.name).toBe(producerGate);
  }
  expect(steps.at(indices[3] ?? -1)?.id).toBe("generate");
  expect(steps.at(indices[4] ?? -1)?.with).toEqual(restored?.with);
  const upload = steps.find(({ name }) => name === "Upload generated sources");
  expect(steps.indexOf(upload ?? steps[0]!)).toBeGreaterThan(indices[4] ?? 0);
  expect(upload?.if, "both paths upload").toBeUndefined();
  expect(upload?.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/u);
  expect(
    upload?.with?.["include-hidden-files"],
    "generated compiler configs must be uploaded",
  ).toBe(true);
  expect(upload?.with).toEqual({
    name: `generated-sources-${producedHash}`,
    path: `\${{ runner.temp }}/generated-sources/`,
    "retention-days": 1,
    "if-no-files-found": "error",
    "include-hidden-files": true,
  });
};

const assertHandoff = (source: Workflow) => {
  assertProducer(source);
  const gate = source.jobs["ci-result"];
  expect(gate?.needs).toContain("ci-plan");
  expect(gate?.needs).toContain("generated-sources");
  const outcome = gate?.steps.find(
    ({ name }) => name === "Evaluate CI outcome",
  );
  expect(outcome?.env?.["PLAN_RESULT"]).toBe(`\${{ needs.ci-plan.result }}`);
  expect(outcome?.run).toContain('if [[ "$PLAN_RESULT" != "success" ]]; then');
  const scopes = v.parse(
    v.record(v.string(), v.nullable(v.string())),
    JSON.parse(outcome?.env?.["JOB_SCOPES"] ?? "{}"),
  );
  expect(scopes["generated-sources"], "producer always planned").toBeNull();
  for (const id of consumerIds(source)) {
    const job = source.jobs[id];
    if (!job) {
      panic(`Missing generated source consumer: ${id}`);
    }
    expect(job.needs, id).toEqual(["ci-plan", "generated-sources"]);
    expect(job.env?.["CI_GENERATED_SOURCES_MANIFEST"], id).toBe(manifest);
    const downloads = job.steps.filter(
      ({ name }) => name === "Download generated sources",
    );
    const restores = job.steps.filter(
      ({ name }) => name === "Restore generated sources",
    );
    expect(downloads, id).toHaveLength(1);
    expect(restores, id).toHaveLength(1);
    const download = downloads.at(0);
    const restore = restores.at(0);
    const hydrationCondition = id.startsWith("ci-checks-")
      ? `\${{ !cancelled() && steps.install.outcome == 'success' && (needs.ci-plan.outputs.package_checks_required == 'true') }}`
      : undefined;
    expect(download?.if, id).toBe(hydrationCondition);
    expect(restore?.if, id).toBe(hydrationCondition);
    expect(download?.uses, id).toMatch(
      /^actions\/download-artifact@[0-9a-f]{40}$/u,
    );
    expect(download?.with, id).toEqual({
      name: artifact,
      path: `\${{ runner.temp }}/generated-sources`,
    });
    expect(download?.["continue-on-error"], id).toBeUndefined();
    expect(restore?.run, id).toBe(restoreCommand);
    expect(restore?.["continue-on-error"], id).toBeUndefined();
    const installIndex = job.steps.findIndex(
      ({ name }) => name === "Install dependencies",
    );
    const downloadIndex = job.steps.findIndex(
      ({ name }) => name === "Download generated sources",
    );
    const restoreIndex = job.steps.findIndex(
      ({ name }) => name === "Restore generated sources",
    );
    expect(installIndex, id).toBeGreaterThan(-1);
    expect(downloadIndex, id).toBeGreaterThan(installIndex);
    expect(restoreIndex, id).toBeGreaterThan(downloadIndex);
    for (const [index, step] of job.steps.entries()) {
      expect(oldPreparation.has(step.name), `${id}/${step.name}`).toBe(false);
      const rawPreparation =
        /\bbun (?:run generate(?:\s|$)|--filter\s+@stll\/web\s+(?:generate:route-tree|generate:api-types)(?![^\n]*--check))/u.test(
          step.run ?? "",
        );
      expect(rawPreparation, `${id}/${step.name}`).toBe(false);
      if (
        step.run &&
        index > installIndex &&
        step.name !== "Prepare environment" &&
        step.name !== "Restore generated sources"
      ) {
        expect(index, `${id}/${step.name}`).toBeGreaterThan(restoreIndex);
      }
    }
  }
};

const assertRegenerationBoundary = (source: Workflow) => {
  const job = source.jobs["ci-checks-generated"];
  if (!job) {
    panic("Missing regeneration guard leg");
  }
  const restored = job.steps.findIndex(
    ({ name }) => name === "Restore generated sources",
  );
  const firstCheck = job.steps.findIndex(
    ({ run }, index) => index > restored && /\bbun\s/u.test(run ?? ""),
  );
  const first = job.steps.at(firstCheck);
  expect(first?.name, "verify before regeneration").toBe(
    "CLI sharded registry and derived runtime guard",
  );
  const run = first?.run ?? "";
  const verification = "bun scripts/ci-generated-sources.ts prepare";
  const detach = "unset CI_GENERATED_SOURCES_MANIFEST";
  const laterSteps = `echo 'CI_GENERATED_SOURCES_MANIFEST=' >> "$GITHUB_ENV"`;
  const regeneration = "(cd packages/cli && bun run codegen)";
  expect(run, "verify before regeneration").toStartWith(
    `set -euo pipefail\n${verification}\n`,
  );
  expect(run.indexOf(detach), "detach current guard").toBeGreaterThan(
    run.indexOf(verification),
  );
  expect(run.indexOf(laterSteps), "detach subsequent guards").toBeGreaterThan(
    run.indexOf(detach),
  );
  expect(
    run.indexOf(regeneration),
    "verify before regeneration",
  ).toBeGreaterThan(run.indexOf(laterSteps));
  for (const step of job.steps.slice(firstCheck + 1)) {
    expect(
      step.env?.["CI_GENERATED_SOURCES_MANIFEST"],
      `no reattached manifest: ${step.name}`,
    ).toBeUndefined();
  }
  for (const id of consumerIds(source).filter(
    (consumerId) => consumerId !== "ci-checks-generated",
  )) {
    for (const step of source.jobs[id]?.steps ?? []) {
      expect(step.run ?? "", `strict consumer: ${id}`).not.toContain(detach);
      expect(step.run ?? "", `strict consumer: ${id}`).not.toContain(
        laterSteps,
      );
    }
  }
};

test("regeneration validates its artifact before clearing both current and subsequent guard reuse", () => {
  assertRegenerationBoundary(workflow);
});

test("missing or late verification and retained manifest reuse break the regeneration boundary", () => {
  for (const mutation of [
    "remove verification",
    "late verification",
    "current manifest",
    "subsequent manifest",
    "early check",
    "reattach",
  ] as const) {
    const mutated = structuredClone(workflow);
    const job = mutated.jobs["ci-checks-generated"];
    const first = job?.steps.find(
      ({ name }) => name === "CLI sharded registry and derived runtime guard",
    );
    if (!job || !first?.run) {
      panic("Missing regeneration mutation fixture");
    }
    const verification = "bun scripts/ci-generated-sources.ts prepare\n";
    switch (mutation) {
      case "remove verification":
        first.run = first.run.replace(verification, "");
        break;
      case "late verification":
        first.run = `${first.run.replace(verification, "")}${verification}`;
        break;
      case "current manifest":
        first.run = first.run.replace(
          "unset CI_GENERATED_SOURCES_MANIFEST\n",
          "",
        );
        break;
      case "subsequent manifest":
        first.run = first.run.replace(
          `echo 'CI_GENERATED_SOURCES_MANIFEST=' >> "$GITHUB_ENV"\n`,
          "",
        );
        break;
      case "early check": {
        const restoreIndex = job.steps.findIndex(
          ({ name }) => name === "Restore generated sources",
        );
        job.steps.splice(restoreIndex + 1, 0, {
          name: "New generator",
          run: "bun --cwd packages/mcp-apps run build",
        });
        break;
      }
      case "reattach":
        job.steps.push({
          name: "New guard",
          run: "bun check",
          env: { CI_GENERATED_SOURCES_MANIFEST: manifest },
        });
        break;
    }
    expect(job).not.toEqual(workflow.jobs["ci-checks-generated"]);
    expect(() => assertRegenerationBoundary(mutated), mutation).toThrow(
      /verify before regeneration|detach current guard|detach subsequent guards|no reattached manifest/u,
    );
  }
});

test("every generated-source consumer restores the same-run artifact before checks", () => {
  expect(consumerIds(workflow).length).toBeGreaterThan(0);
  assertHandoff(workflow);
});

test("generated-source uploads include ignored compiler configs", () => {
  for (const value of [undefined, false]) {
    const mutated = structuredClone(workflow);
    const upload = mutated.jobs["generated-sources"]?.steps.find(
      ({ name }) => name === "Upload generated sources",
    );
    if (!upload?.with) {
      panic("Missing generated source upload fixture");
    }
    if (value === undefined) {
      delete upload.with["include-hidden-files"];
    } else {
      upload.with["include-hidden-files"] = value;
    }
    expect(() => assertHandoff(mutated)).toThrow(
      "generated compiler configs must be uploaded",
    );
  }
});

test("the documentation job consumes Markdown without generated-source hydration", () => {
  const job = workflow.jobs["ci-quick-checks"];
  expect(job?.needs).toBe("ci-plan");
  const markdown = job?.steps.filter(({ run }) =>
    run?.includes("--run-markdown-checks"),
  );
  expect(markdown).toHaveLength(1);
  expect(markdown?.at(0)?.if).toContain(
    "needs.ci-plan.outputs.docs_checks_required == 'true'",
  );
  expect(
    job?.steps.some(({ name }) => name === "Restore generated sources"),
  ).toBe(false);
  expect(consumerIds(workflow)).not.toContain("ci-quick-checks");
  const mutated = structuredClone(workflow);
  mutated.jobs["ci-checks-new"] = {
    needs: "ci-plan",
    steps: [{ name: "Check", run: "bun check" }],
  };
  expect(() => assertHandoff(mutated)).toThrow("ci-checks-new");
});

test("new consumers cannot omit generated-source hydration", () => {
  const mutated = structuredClone(workflow);
  mutated.jobs["code-quality-new"] = {
    needs: "ci-plan",
    steps: [{ name: "Check", run: "bun check" }],
  };
  expect(() => assertHandoff(mutated)).toThrow("code-quality-new");
});

test("consumer hydration rejects missing dependencies, provenance, ordering and raw preparation", () => {
  for (const id of consumerIds(workflow)) {
    for (const mutation of [
      "dependency",
      "manifest",
      "download",
      "restore",
      "artifact",
      "cross-run",
      "continue",
      "condition",
      "order",
      "generation",
    ] as const) {
      const mutated = structuredClone(workflow);
      const job = mutated.jobs[id];
      if (!job) {
        panic(`Missing hydration mutation fixture: ${id}`);
      }
      const download = job.steps.find(
        ({ name }) => name === "Download generated sources",
      );
      const restore = job.steps.find(
        ({ name }) => name === "Restore generated sources",
      );
      if (!download?.with || !restore || !job.env) {
        panic(`Incomplete hydration mutation fixture: ${id}`);
      }
      switch (mutation) {
        case "dependency":
          job.needs = ["ci-plan", "ci-quick-checks"];
          break;
        case "manifest":
          delete job.env["CI_GENERATED_SOURCES_MANIFEST"];
          break;
        case "download":
          job.steps = job.steps.filter((step) => step !== download);
          break;
        case "restore":
          job.steps = job.steps.filter((step) => step !== restore);
          break;
        case "artifact":
          download.with["name"] = "generated-sources-other";
          break;
        case "cross-run":
          download.with["run-id"] = "123";
          break;
        case "continue":
          restore["continue-on-error"] = true;
          break;
        case "condition":
          restore.if = "false";
          break;
        case "order":
          job.steps = [
            restore,
            ...job.steps.filter((step) => step !== restore),
          ];
          break;
        case "generation":
          job.steps.push({
            name: "Unlisted preparation",
            run: "bun run generate",
          });
          break;
      }
      expect(() => assertHandoff(mutated), `${id}/${mutation}`).toThrow(id);
    }
  }
});

test("generated-source production remains required in every result gate", () => {
  for (const mutation of [
    "needs",
    "plan result",
    "ungated step",
    "order",
    "output",
    "waits for plan",
    "scoped",
    "loose cache",
    "unproven reuse",
  ] as const) {
    const mutated = structuredClone(workflow);
    const gate = mutated.jobs["ci-result"];
    const plan = mutated.jobs["generated-sources"];
    const outcome = gate?.steps.find(
      ({ name }) => name === "Evaluate CI outcome",
    );
    const produce = plan?.steps.find(
      ({ name }) => name === "Produce generated sources",
    );
    const restore = plan?.steps.find(({ id }) => id === "cache");
    const reuse = plan?.steps.find(({ id }) => id === "cached");
    if (
      !gate ||
      !plan?.outputs ||
      !produce ||
      !restore?.with ||
      !reuse?.run ||
      !outcome?.run ||
      !outcome.env ||
      !Array.isArray(gate.needs)
    ) {
      panic("Missing producer gate mutation fixture");
    }
    switch (mutation) {
      case "needs":
        gate.needs = gate.needs.filter((id) => id !== "generated-sources");
        break;
      case "waits for plan":
        plan.needs = "ci-plan";
        break;
      case "scoped":
        outcome.env["JOB_SCOPES"] = outcome.env["JOB_SCOPES"]!.replace(
          '"generated-sources": null',
          '"generated-sources": "package_checks_required"',
        );
        break;
      case "loose cache":
        restore.with["restore-keys"] = "generated-sources-v1-";
        break;
      case "unproven reuse":
        reuse.run = reuse.run.replace(
          '"$source_sha" != "$(git rev-parse HEAD)"',
          "false",
        );
        break;
      case "plan result":
        outcome.run = outcome.run.replace(
          'if [[ "$PLAN_RESULT" != "success" ]]; then',
          'if [[ "$PLAN_RESULT" == "failure" ]]; then',
        );
        break;
      case "ungated step":
        delete produce.if;
        break;
      case "order":
        plan.steps = [
          produce,
          ...plan.steps.filter((step) => step !== produce),
        ];
        break;
      case "output":
        delete plan.outputs["input_hash"];
        break;
    }
    expect(() => assertHandoff(mutated), mutation).toThrow(
      /Expected|Received/u,
    );
  }
});

// A cache hit skips the producer script, so the entry must come from a run
// that passed its tracking guard, and every consumer restore repeats it.
test("every producer and restore path proves MCP outputs untracked", () => {
  const producer = readFileSync(
    new URL("ci-generated-sources.ts", import.meta.url),
    "utf-8",
  );
  const guard = producer.indexOf("checkMcpGeneratedTracking(root);");
  expect(guard).toBeGreaterThan(-1);
  expect(guard).toBeLessThan(producer.indexOf("const mode ="));
  const steps = workflow.jobs["generated-sources"]?.steps ?? [];
  const produce = steps.findIndex(({ id }) => id === "generate");
  const save = steps.findIndex(({ name }) => name === "Save generated sources");
  expect(save).toBeGreaterThan(produce);
  expect(steps.at(save)?.if).toBe(producerGate);
  for (const id of consumerIds(workflow)) {
    expect(
      workflow.jobs[id]?.steps.some(({ run }) => run === restoreCommand),
      id,
    ).toBe(true);
  }
});

test("CLI runtime determinism remains a fresh generation proof", () => {
  const source = readFileSync(
    new URL("check-cli-runtime-generation.ts", import.meta.url),
    "utf-8",
  );
  expect(source).toContain('["packages/cli/src/codegen.ts", "--runtime-only"]');
  expect(source).not.toContain('"codegen:runtime"');
});

const generationCommandViolations = (command: readonly string[]) => {
  const [binary, target, action, script, ...extra] = command;
  if (binary !== "bun" || target === undefined) {
    return ["Expected Bun generator command"];
  }
  if (target === "node_modules/turbo/bin/turbo") {
    const filter = extra.at(0);
    const packageName = filter?.match(/^--filter=(@stll\/([a-z-]+))$/u);
    const workspace = packageName?.at(1);
    const directory = packageName?.at(2);
    if (
      action !== "run" ||
      script === undefined ||
      extra.length !== 1 ||
      workspace === undefined ||
      directory === undefined ||
      !existsSync(new URL(`../${target}`, import.meta.url))
    ) {
      return ["Expected rooted Turbo launcher and one explicit workspace task"];
    }
    const config = v.parse(
      v.object({ tasks: v.record(v.string(), v.unknown()) }),
      Bun.JSONC.parse(
        readFileSync(new URL("../turbo.json", import.meta.url), "utf-8"),
      ),
    );
    if (!Object.hasOwn(config.tasks, `${workspace}#${script}`)) {
      return ["Turbo owner task does not exist"];
    }
    const manifestPath = ["apps", "packages"]
      .map(
        (scope) =>
          new URL(`../${scope}/${directory}/package.json`, import.meta.url),
      )
      .find((filename) => existsSync(filename));
    if (manifestPath === undefined) {
      return ["Workspace package does not exist"];
    }
    const owner = v.parse(
      v.object({ name: v.string(), scripts: v.record(v.string(), v.string()) }),
      JSON.parse(readFileSync(manifestPath, "utf-8")),
    );
    return owner.name === workspace && Object.hasOwn(owner.scripts, script)
      ? []
      : ["Turbo owner package script does not exist"];
  }
  if (!target.startsWith("--cwd=")) {
    return command.length === 2 &&
      existsSync(new URL(`../${target}`, import.meta.url))
      ? []
      : ["Expected a direct generator file or explicit package script"];
  }
  if (action !== "run" || script === undefined || extra.length !== 0) {
    return ["Expected explicit package script invocation"];
  }
  const packageManifest = v.parse(
    v.object({ scripts: v.record(v.string(), v.string()) }),
    JSON.parse(
      readFileSync(
        new URL(
          `../${target.slice("--cwd=".length)}/package.json`,
          import.meta.url,
        ),
        "utf-8",
      ),
    ),
  );
  return Object.hasOwn(packageManifest.scripts, script)
    ? []
    : ["Package script does not exist"];
};

test("every preparation command resolves a real generator file or package script", () => {
  for (const command of CI_GENERATION_COMMANDS) {
    expect(generationCommandViolations(command), command.join(" ")).toEqual([]);
  }
  for (const command of [
    [
      "bun",
      "node_modules/turbo/bin/turbo",
      "run",
      "missing-task",
      "--filter=@stll/web",
    ],
    ["bun", "node_modules/turbo/bin/turbo", "run", "generate:api-types"],
    [
      "bun",
      "node_modules/turbo/bin/turbo",
      "run",
      "generate:api-types",
      "--filter=@stll/missing",
    ],
    [
      "bun",
      "node_modules/turbo/bin/turbo",
      "run",
      "generate:api-types",
      "--filter=@stll/web",
      "--filter=@stll/api",
    ],
    ["bun", "exec", "turbo", "run", "generate:api-types", "--filter=@stll/web"],
  ]) {
    expect(generationCommandViolations(command), command.join(" ")).not.toEqual(
      [],
    );
  }
  const producer = readFileSync(
    new URL("ci-generated-sources.ts", import.meta.url),
    "utf-8",
  );
  expect(producer).toContain("for (const command of CI_GENERATION_COMMANDS)");
  expect(
    generationCommandViolations([
      "bun",
      "--filter",
      "@stll/web",
      "run",
      "typegen",
    ]).length,
  ).toBeGreaterThan(0);
  expect(
    generationCommandViolations([
      "bun",
      "--cwd=apps/web",
      "run",
      "missing-fixture-script",
    ]).length,
  ).toBeGreaterThan(0);
});

test("API boot entry points prepare capability runtime sources before starting", () => {
  const action = v.parse(
    v.object({ runs: v.object({ steps: v.array(stepSchema) }) }),
    Bun.YAML.parse(
      readFileSync(
        new URL(
          "../.github/actions/setup-e2e-stack/action.yml",
          import.meta.url,
        ),
        "utf-8",
      ),
    ),
  );
  const assertPrepared = (steps: typeof action.runs.steps) => {
    const preparation = steps.findIndex(
      ({ run }) => run === "bun --filter @stll/api generate:capability-runtime",
    );
    const boot = steps.findIndex(({ name }) => name === "Start API server");
    expect(preparation).toBeGreaterThanOrEqual(0);
    expect(boot).toBeGreaterThan(preparation);
    for (const name of ["Run database migrations", "Seed test user"]) {
      expect(
        steps.findIndex((step) => step.name === name),
        name,
      ).toBeGreaterThan(preparation);
    }
    expect(steps.at(preparation)?.if).toBe(steps.at(boot)?.if);
  };
  assertPrepared(action.runs.steps);
  const missing = action.runs.steps.filter(
    ({ run }) => run !== "bun --filter @stll/api generate:capability-runtime",
  );
  expect(missing.length).toBe(action.runs.steps.length - 1);
  expect(() => assertPrepared(missing)).toThrow("toBeGreaterThanOrEqual");

  const api = v.parse(
    v.object({ scripts: v.record(v.string(), v.string()) }),
    JSON.parse(
      readFileSync(
        new URL("../apps/api/package.json", import.meta.url),
        "utf-8",
      ),
    ),
  );
  for (const command of [
    "build",
    "build:analyze",
    "dev",
    "test",
    "test:property",
    "lint",
    "lint:fix",
  ]) {
    expect(api.scripts[command], command).toContain(
      "bun run generate:capability-runtime &&",
    );
  }
  const root = v.parse(
    v.object({ scripts: v.record(v.string(), v.string()) }),
    JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    ),
  );
  expect(root.scripts["generate"]).toContain("generate:capability-runtime");
  expect(root.scripts["generate"]).toContain("--filter=@stll/api");
  const turbo = v.parse(
    v.object({
      tasks: v.record(
        v.string(),
        v.looseObject({ dependsOn: v.optional(v.array(v.string())) }),
      ),
    }),
    Bun.JSONC.parse(
      readFileSync(new URL("../turbo.json", import.meta.url), "utf-8"),
    ),
  );
  expect(api.scripts["typecheck"]).toBe(
    "bun ../../packages/scripts/src/api-typecheck.ts",
  );
  for (const command of ["lint", "lint:fix"]) {
    const script =
      api.scripts[command] ?? panic(`Missing API ${command} script`);
    const emission = script.indexOf(
      "turbo run generate:typecheck-declarations --filter=@stll/api",
    );
    expect(emission).toBeGreaterThanOrEqual(0);
    expect(script.indexOf("bun --bun oxlint")).toBeGreaterThan(emission);
  }
  expect(turbo.tasks["@stll/api#typecheck"]?.dependsOn).toContain(
    "typecheck:src",
  );
  expect(turbo.tasks["@stll/api#typecheck:src"]?.dependsOn).toContain(
    "generate:capability-runtime",
  );
  expect(turbo.tasks["@stll/web#generate:api-types"]?.dependsOn).toContain(
    "@stll/api#generate:capability-runtime",
  );
  const docker = readFileSync(
    new URL("../apps/api/Dockerfile", import.meta.url),
    "utf-8",
  );
  expect(
    docker.indexOf("RUN bun apps/api/scripts/generate-capability-runtime.ts"),
  ).toBeGreaterThanOrEqual(0);
  expect(
    docker.indexOf("RUN bun apps/api/scripts/generate-capability-runtime.ts"),
  ).toBeLessThan(docker.indexOf("RUN bun build"));
  const runtime = docker.indexOf(
    "RUN bun apps/api/scripts/generate-capability-runtime.ts",
  );
  const contracts = docker.indexOf(
    "bun apps/api/scripts/generate-mcp-app-contracts.ts",
  );
  const bundles = docker.indexOf(
    "bun packages/mcp-apps/scripts/build-mcp-apps.ts",
  );
  expect(contracts).toBeGreaterThan(runtime);
  expect(bundles).toBeGreaterThan(contracts);
  expect(bundles).toBeLessThan(docker.indexOf("RUN bun build"));
  expect(api.scripts["generate:capability-runtime"]).toContain(
    "bun ../../scripts/prepare-mcp-apps.ts",
  );
});

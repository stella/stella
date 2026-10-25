import { panic } from "better-result";
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as v from "valibot";

import { PR_CODE_QUALITY_CANCEL_JOBS } from "./ci-cancellation-contract";
import { CI_GENERATION_COMMANDS } from "./generated-files";
import { lexShell, programWords } from "./install-free-ci";

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
      if: v.optional(v.string()),
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
// The cancellation helpers only end a failed run; they check no sources.
const cancellationHelpers = new Set<string>(
  Object.keys(PR_CODE_QUALITY_CANCEL_JOBS),
);
const consumerIds = (source: Workflow) =>
  Object.keys(source.jobs).filter(
    (id) =>
      !cancellationHelpers.has(id) &&
      (id.startsWith("ci-checks-") ||
        id.startsWith("code-quality-") ||
        id === "typecheck-baseline"),
  );
const manifest = `\${{ github.workspace }}/.cache/ci-generated-sources/manifest.json`;
const artifact = `generated-sources-\${{ needs.generated-sources.outputs.input_hash }}`;
const producedHash = `\${{ steps.generate.outputs.input_hash || steps.cached.outputs.input_hash }}`;
const restoreCommand =
  'bun scripts/ci-generated-sources.ts restore "$RUNNER_TEMP/generated-sources"';
// The script reads artifacts of this run only (GITHUB_RUN_ID).
const downloadCommand =
  'bash scripts/download-run-artifact.sh --name "$ARTIFACT_NAME" --path "$RUNNER_TEMP/generated-sources"';
const downloadEnvKeys = new Set([
  "ARTIFACT_NAME",
  "CI_CHECK_CONTEXT",
  "CI_CHECK_KIND",
  "GH_TOKEN",
]);
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

// Only the consumers wait for generation, and the producer runs exactly when
// they do, so a reused, untrusted or package-free run never generates. A
// failed producer skips its consumers and fails the result gate.
const assertProducer = (source: Workflow) => {
  const producer = source.jobs["generated-sources"];
  expect(producer, "generated producer").toBeDefined();
  expect(producer?.needs, "producer follows the plan").toBe("ci-plan");
  expect(producer?.if, "producer runs with its consumers").toBe(
    source.jobs["ci-checks-generated"]?.if,
  );
  expect(producer?.steps.at(-1)?.name).toBe(
    "Cancel merge group after failure in this job",
  );
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
  const uploadIndex = steps.findIndex(
    ({ name }) => name === "Upload generated sources",
  );
  const upload = steps.at(uploadIndex);
  expect(uploadIndex, "upload after save").toBeGreaterThan(indices[4] ?? -1);
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
  expect(scopes["generated-sources"], "producer planned with packages").toBe(
    "package_checks_required",
  );
  for (const id of consumerIds(source)) {
    const job = source.jobs[id];
    if (!job) {
      panic(`Missing generated source consumer: ${id}`);
    }
    // A check that waits for the quick checks also names their gate. It runs
    // past `!cancelled()`, so its condition must require the producer itself.
    const gated =
      Array.isArray(job.needs) && job.needs.includes("pr-heavy-gate");
    expect(job.needs, id).toEqual([
      "ci-plan",
      "generated-sources",
      ...(gated ? ["pr-heavy-gate"] : []),
    ]);
    if (gated) {
      expect(job.if, id).toContain(
        "&& needs.generated-sources.result == 'success' &&",
      );
    }
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
    expect(download?.uses, id).toBeUndefined();
    expect(download?.with, id).toBeUndefined();
    expect(download?.run, id).toBe(downloadCommand);
    expect(download?.env?.["ARTIFACT_NAME"], id).toBe(artifact);
    expect(download?.env?.["GH_TOKEN"], id).toBe(`\${{ github.token }}`);
    expect(
      Object.keys(download?.env ?? {}).filter(
        (key) => !downloadEnvKeys.has(key),
      ),
      id,
    ).toEqual([]);
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
        step.name !== "Download generated sources" &&
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
      "gate",
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
      if (!download?.env || !restore || !job.env) {
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
          download.env["ARTIFACT_NAME"] = "generated-sources-other";
          break;
        case "cross-run":
          download.env["GITHUB_RUN_ID"] = "123";
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
        case "gate":
          // Waiting on the gate without requiring the producer's success.
          job.needs = ["ci-plan", "generated-sources", "pr-heavy-gate"];
          job.if = job.if?.replace(
            " && needs.generated-sources.result == 'success'",
            "",
          );
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
    "starts before plan",
    "unscoped",
    "reuse runs",
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
      case "starts before plan":
        delete plan.needs;
        break;
      case "unscoped":
        outcome.env["JOB_SCOPES"] = (
          outcome.env["JOB_SCOPES"] ?? panic("Missing JOB_SCOPES fixture")
        ).replace(
          '"generated-sources": "package_checks_required"',
          '"generated-sources": null',
        );
        break;
      case "reuse runs":
        plan.if = (plan.if ?? "").replace(
          "needs.ci-plan.outputs.pr_depth_reused != 'true'",
          "true",
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

// A web app served from source imports every generated module the registry
// owns. A built app does not need this: its build runs the generators.
const startsWebFromSource = (run: string) =>
  lexShell(run).some((event) => {
    if (event.type !== "command") {
      return false;
    }
    const words = programWords(event.words);
    if (
      words.at(0) === "bun" &&
      words.at(1) === "run" &&
      words.at(2) === "dev:web"
    ) {
      return true;
    }
    let args: string[] | null = null;
    if (words.at(0) === "vite") {
      args = words.slice(1);
    } else if (words.at(0) === "bunx" && words.at(1) === "vite") {
      args = words.slice(2);
    } else if (
      words.at(0) === "bun" &&
      words.at(1) === "--bun" &&
      words.at(2) === "vite"
    ) {
      args = words.slice(3);
    }
    if (
      args === null ||
      args.includes("--help") ||
      args.includes("--version")
    ) {
      return false;
    }
    const command = args.at(0);
    return (
      command === undefined ||
      command.startsWith("-") ||
      command === "dev" ||
      command === "serve"
    );
  });
const REGISTRY_PREPARE = "bun scripts/ci-generated-sources.ts prepare";
const preparesGeneratedSources = (run: string) =>
  lexShell(run).some((event) => {
    if (event.type !== "command") {
      return false;
    }
    const words = programWords(event.words);
    return (
      words.at(0) === "bun" &&
      words.at(1) === "scripts/ci-generated-sources.ts" &&
      ((words.at(2) === "prepare" && words.length === 3) ||
        (words.at(2) === "restore" &&
          words.length === 4 &&
          words.at(3)?.startsWith("-") === false))
    );
  });
const looseWorkflow = v.object({
  jobs: v.optional(
    v.record(
      v.string(),
      v.looseObject({
        steps: v.optional(
          v.array(
            v.looseObject({
              name: v.optional(v.string()),
              run: v.optional(v.string()),
            }),
          ),
        ),
      }),
    ),
  ),
});
type LooseWorkflow = v.InferOutput<typeof looseWorkflow>;

const unpreparedSourceStarts = (file: string, source: LooseWorkflow) =>
  Object.entries(source.jobs ?? {}).flatMap(([id, job]) => {
    const steps = job.steps ?? [];
    const start = steps.findIndex(({ run }) => startsWebFromSource(run ?? ""));
    if (start === -1) {
      return [];
    }
    const prepared = steps
      .slice(0, start)
      .some(({ run }) => preparesGeneratedSources(run ?? ""));
    return prepared ? [] : [`${file}/${id}/${steps[start]?.name ?? start}`];
  });

test("every job that serves the web app from source runs the generated-source registry first", () => {
  const directory = new URL("../.github/workflows/", import.meta.url);
  const workflows = [...new Bun.Glob("*.yml").scanSync(directory.pathname)]
    .toSorted()
    .map((file) => ({
      file,
      source: v.parse(
        looseWorkflow,
        Bun.YAML.parse(readFileSync(new URL(file, directory), "utf-8")),
      ),
    }));
  const starters = workflows.flatMap(({ file, source }) =>
    Object.entries(source.jobs ?? {})
      .filter(([, job]) =>
        (job.steps ?? []).some(({ run }) => startsWebFromSource(run ?? "")),
      )
      .map(([id]) => `${file}/${id}`),
  );
  expect(starters).toContain("ci.yml/e2e-vite-canary");
  expect(
    workflows.flatMap(({ file, source }) =>
      unpreparedSourceStarts(file, source),
    ),
  ).toEqual([]);

  // Dropping the registry step leaves the dev server without its modules.
  const mutated = structuredClone(
    workflows.find(({ file }) => file === "ci.yml")?.source ??
      panic("Missing ci.yml"),
  );
  const canary = mutated.jobs?.["e2e-vite-canary"] ?? panic("Missing canary");
  canary.steps = (canary.steps ?? []).filter(
    ({ run }) => !(run ?? "").includes(REGISTRY_PREPARE),
  );
  expect(unpreparedSourceStarts("ci.yml", mutated)).toEqual([
    "ci.yml/e2e-vite-canary/Start web dev server",
  ]);
});

test.each([
  ["bun --bun vite --port 3000", true],
  ["nohup bun --bun vite --port 3000 > /tmp/web.log 2>&1 &", true],
  ["CI=true bunx vite dev --host 127.0.0.1", true],
  ["vite serve", true],
  ["bun run dev:web", true],
  ["echo 'bun --bun vite'", false],
  ["# bun --bun vite", false],
  ["cat <<'TEXT'\nbun --bun vite\nTEXT", false],
  ["bun --bun vite build", false],
  ["bunx vite preview", false],
  ["vite --version", false],
])(
  "only executable development commands start the web app: %s",
  (run, starts) => {
    expect(startsWebFromSource(run)).toBe(starts);
  },
);

test.each([
  [REGISTRY_PREPARE, true],
  [`CI_CHECK_KIND=CONTEXTUAL ${REGISTRY_PREPARE}`, true],
  [
    'bun scripts/ci-generated-sources.ts restore "$RUNNER_TEMP/generated-sources"',
    true,
  ],
  [`echo '${REGISTRY_PREPARE}'`, false],
  [`# ${REGISTRY_PREPARE}`, false],
  [`cat <<'TEXT'\n${REGISTRY_PREPARE}\nTEXT`, false],
  ["bun scripts/ci-generated-sources.ts restore", false],
  ["echo 'Nothing to restore'", false],
])(
  "source preparation requires an executable registry command: %s",
  (run, prepared) => {
    const source = {
      jobs: {
        web: {
          steps: [
            { name: "Restore generated sources", run },
            { name: "Serve", run: "bun --bun vite" },
          ],
        },
      },
    };
    expect(unpreparedSourceStarts("fixture.yml", source)).toEqual(
      prepared ? [] : ["fixture.yml/web/Serve"],
    );
  },
);

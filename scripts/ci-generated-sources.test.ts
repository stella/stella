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
      (id.startsWith("ci-checks-") && id !== "ci-checks-docs") ||
      id.startsWith("code-quality-") ||
      id === "typecheck-baseline",
  );
const manifest = `\${{ github.workspace }}/.cache/ci-generated-sources/manifest.json`;
const artifact = `generated-sources-\${{ needs.ci-generated-sources.outputs.input_hash }}`;
const restoreCommand =
  'bun scripts/ci-generated-sources.ts restore "$RUNNER_TEMP/generated-sources"';
const oldPreparation = new Set([
  "Generate web sources",
  "Generate web route tree",
  "Generate web compiler sources",
  "Generate types",
]);

const assertHandoff = (source: Workflow) => {
  const producer = source.jobs["ci-generated-sources"];
  expect(producer, "generated producer").toBeDefined();
  expect(producer?.outputs?.["input_hash"]).toBe(
    `\${{ steps.generate.outputs.input_hash }}`,
  );
  const upload = producer?.steps.find(
    ({ name }) => name === "Upload generated sources",
  );
  expect(upload?.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/u);
  expect(upload?.with).toEqual({
    name: `generated-sources-\${{ steps.generate.outputs.input_hash }}`,
    path: `\${{ runner.temp }}/generated-sources/`,
    "retention-days": 1,
    "if-no-files-found": "error",
  });
  const gate = source.jobs["ci-result"];
  expect(gate?.needs).toContain("ci-generated-sources");
  const outcome = gate?.steps.find(
    ({ name }) => name === "Evaluate CI outcome",
  );
  const scopes = v.parse(
    v.record(v.string(), v.nullable(v.string())),
    JSON.parse(outcome?.env?.["JOB_SCOPES"] ?? ""),
  );
  expect(Object.hasOwn(scopes, "ci-generated-sources")).toBe(true);
  expect(scopes["ci-generated-sources"]).toBe("package_checks_required");
  const fast = v.parse(
    v.array(v.string()),
    JSON.parse(outcome?.env?.["FAST_REQUIRED"] ?? ""),
  );
  expect(fast).toContain("ci-generated-sources");
  for (const id of consumerIds(source)) {
    const job = source.jobs[id];
    if (!job) {
      panic(`Missing generated source consumer: ${id}`);
    }
    expect(job.needs, id).toEqual(["ci-plan", "ci-generated-sources"]);
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

test("the documentation job consumes Markdown without generated-source hydration", () => {
  const job = workflow.jobs["ci-checks-docs"];
  expect(job?.needs).toBe("ci-plan");
  expect(job?.["if"]).toContain(
    "needs.ci-plan.outputs.docs_checks_required == 'true'",
  );
  expect(
    job?.steps.filter(({ run }) => run?.includes("--run-markdown-checks")),
  ).toHaveLength(1);
  expect(
    job?.steps.some(({ name }) => name === "Restore generated sources"),
  ).toBe(false);
  expect(consumerIds(workflow)).not.toContain("ci-checks-docs");
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
          job.needs = ["ci-plan"];
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
  for (const field of ["needs", "JOB_SCOPES", "FAST_REQUIRED"] as const) {
    const mutated = structuredClone(workflow);
    const gate = mutated.jobs["ci-result"];
    const outcome = gate?.steps.find(
      ({ name }) => name === "Evaluate CI outcome",
    );
    if (!gate || !outcome?.env || !Array.isArray(gate.needs)) {
      panic("Missing producer gate mutation fixture");
    }
    if (field === "needs") {
      gate.needs = gate.needs.filter((id) => id !== "ci-generated-sources");
    } else if (field === "JOB_SCOPES") {
      const scopes = v.parse(
        v.record(v.string(), v.nullable(v.string())),
        JSON.parse(outcome.env[field] ?? ""),
      );
      delete scopes["ci-generated-sources"];
      outcome.env[field] = JSON.stringify(scopes);
    } else {
      const fast = v.parse(
        v.array(v.string()),
        JSON.parse(outcome.env[field] ?? ""),
      );
      outcome.env[field] = JSON.stringify(
        fast.filter((id) => id !== "ci-generated-sources"),
      );
    }
    expect(() => assertHandoff(mutated), field).toThrow("expect(received)");
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
    "typecheck",
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
});

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { lexShell } from "./install-free-ci";
import { workflowJobSteps } from "./workflow-steps";

const root = path.resolve(import.meta.dirname, "..");
const workflow: unknown = Bun.YAML.parse(
  readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf-8"),
);
const targets = {
  "e2e-report": ["@stll/playwright-tools", "!stella"],
  "docker-checks": ["@stll/agent-engine...", "stella"],
  "landing-build": ["@stll/landing...", "stella"],
  "e2e-landing": ["@stll/landing...", "stella"],
} as const;

const installFilters = (command: string) => {
  const invocations = [...lexShell(command)]
    .filter((event) => event.type === "command")
    .map(({ words }) => words.slice(words.indexOf("bun")))
    .filter((words) => words.at(0) === "bun" && words.at(1) === "ci");
  expect(invocations).toHaveLength(1);
  const words = invocations.at(0) ?? [];
  expect(words).toContain("--frozen-lockfile");
  expect(words).toContain("--ignore-scripts");
  return words.flatMap((word, index) =>
    word === "--filter" ? [words.at(index + 1)] : [],
  );
};

for (const [job, filters] of Object.entries(targets)) {
  test(`${job} installs only its frozen task closure`, () => {
    const install = workflowJobSteps(workflow, job).find(
      (step) => step["name"] === "Install dependencies",
    );
    const command = v.parse(v.string(), install?.["run"]);
    expect(installFilters(command)).toEqual(filters);
  });
}

test("a full workspace install cannot satisfy a scoped job", () => {
  const full =
    "bash scripts/retry.sh bun ci --frozen-lockfile --ignore-scripts";
  for (const filters of Object.values(targets)) {
    expect(installFilters(full)).not.toEqual(filters);
  }
});

const manifestSchema = v.object({
  name: v.string(),
  dependencies: v.optional(v.record(v.string(), v.string()), {}),
  devDependencies: v.optional(v.record(v.string(), v.string()), {}),
  optionalDependencies: v.optional(v.record(v.string(), v.string()), {}),
});
const manifests = new Map(
  [
    "package.json",
    ...new Bun.Glob("{apps,packages}/*/package.json").scanSync({ cwd: root }),
  ].map((file) => {
    const manifest = v.parse(
      manifestSchema,
      JSON.parse(readFileSync(path.join(root, file), "utf-8")),
    );
    return [manifest.name, manifest] as const;
  }),
);
const locked = v.parse(
  v.object({ packages: v.record(v.string(), v.array(v.unknown())) }),
  Bun.JSONC.parse(readFileSync(path.join(root, "bun.lock"), "utf-8")),
);
const packageDependencies = new Map<string, Set<string>>();
const dependencyMetadata = v.object({
  dependencies: v.optional(v.record(v.string(), v.string()), {}),
  optionalDependencies: v.optional(v.record(v.string(), v.string()), {}),
  peerDependencies: v.optional(v.record(v.string(), v.string()), {}),
});
for (const entry of Object.values(locked.packages)) {
  const resolution = v.parse(v.string(), entry.at(0));
  const name = resolution.slice(0, resolution.lastIndexOf("@"));
  const metadata = v.parse(dependencyMetadata, entry.at(2) ?? {});
  const dependencies = packageDependencies.get(name) ?? new Set<string>();
  for (const dependency of Object.keys({
    ...metadata.dependencies,
    ...metadata.optionalDependencies,
    ...metadata.peerDependencies,
  })) {
    dependencies.add(dependency);
  }
  packageDependencies.set(name, dependencies);
}
const closure = (seeds: readonly string[]) => {
  const visited = new Set<string>();
  const pending = [...seeds];
  for (const name of pending) {
    if (visited.has(name)) {
      continue;
    }
    visited.add(name);
    const manifest = manifests.get(name);
    if (manifest === undefined) {
      pending.push(...(packageDependencies.get(name) ?? []));
      continue;
    }
    pending.push(
      ...Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.optionalDependencies,
      }),
    );
  }
  return visited;
};

test("the scoped closures exclude the API and ONNX runtime", () => {
  for (const [job, filters] of Object.entries(targets)) {
    const seeds = filters
      .filter((filter) => !filter.startsWith("!"))
      .map((filter) => filter.replace(/\.\.\.$/u, ""));
    const installed = closure(seeds);
    expect(installed.has("@stll/api"), job).toBe(false);
    expect(installed.has("onnxruntime-node"), job).toBe(false);
    if (job === "e2e-report") {
      expect(
        [...installed].filter(
          (name) => name.startsWith("@stll/") && manifests.has(name),
        ),
      ).toEqual(["@stll/playwright-tools", "@stll/typescript-config"]);
    }
  }
});

test("landing owns its browser task without invoking web generation", () => {
  const landing = v.parse(
    v.object({ scripts: v.record(v.string(), v.string()) }),
    JSON.parse(
      readFileSync(path.join(root, "apps/landing/package.json"), "utf-8"),
    ),
  );
  expect(landing.scripts["test:e2e"]).toBe(
    "playwright test --config e2e/playwright.config.ts --project landing",
  );
  const steps = workflowJobSteps(workflow, "e2e-landing");
  const browser = v.parse(
    v.string(),
    steps.find((step) => step["name"] === "Check landing islands")?.["run"],
  );
  expect(browser).toContain("setup-playwright/run-in-image.sh");
  expect(browser).toContain("bun --filter @stll/landing test:e2e");
});

for (const scope of ["landing", "marketing"]) {
  test(`${scope} browser selection follows the shared configuration owner`, () => {
    for (const file of [
      "packages/playwright-tools/src/marketing-config.ts",
      "packages/playwright-tools/src/env.ts",
      "packages/playwright-tools/package.json",
    ]) {
      const result = Bun.spawnSync(
        ["bash", "scripts/detect-e2e-changes.sh", scope, file],
        { cwd: root },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stdout.toString().trim(), `${scope}/${file}`).toBe("true");
    }
  });
}

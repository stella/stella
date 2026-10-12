import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { workflowJobSteps } from "./workflow-steps";

const root = path.resolve(import.meta.dirname, "..");
const workflow: unknown = Bun.YAML.parse(
  readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf-8"),
);
const targets = {
  "e2e-report": ["@stll/playwright-tools", "!stella"],
  "desktop-windows-dry-run": ["@stll/desktop...", "!stella"],
  "docker-checks": ["@stll/agent-engine...", "stella"],
  "landing-build": ["@stll/landing...", "@stll/cli...", "stella"],
  "e2e-landing": ["@stll/landing...", "@stll/cli...", "stella"],
} as const;

const filtersFromFlags = (flags: readonly string[]) => {
  expect(flags).toContain("--frozen-lockfile");
  expect(flags).toContain("--ignore-scripts");
  return flags.flatMap((flag, index) =>
    flag === "--filter" ? [flags.at(index + 1)] : [],
  );
};

const actionFlags = (step: Record<string, unknown>) => {
  const selector = v.parse(v.string(), step["uses"]);
  expect([
    "$/.github/actions/ci-install",
    "./.github/actions/ci-install",
  ]).toContain(selector);
  const inputs = v.parse(v.object({ flags: v.string() }), step["with"]);
  return v.parse(v.array(v.string()), JSON.parse(inputs.flags));
};

const installFiltersFromAction = (step: Record<string, unknown>) =>
  filtersFromFlags(actionFlags(step));

for (const [job, filters] of Object.entries(targets)) {
  test(`${job} installs only its frozen task closure`, () => {
    const install = workflowJobSteps(workflow, job).find(
      (step) => step["name"] === "Install dependencies",
    );
    if (install === undefined) {
      expect.unreachable(`Missing ${job} install`);
    }
    expect(installFiltersFromAction(install)).toEqual([...filters]);
  });
}

test("a full workspace install cannot satisfy a scoped job", () => {
  const full = ["--frozen-lockfile", "--ignore-scripts"];
  for (const filters of Object.values(targets)) {
    expect(filtersFromFlags(full)).not.toEqual([...filters]);
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

test("the Windows desktop install excludes unrelated application graphs", () => {
  const installed = closure(["@stll/desktop"]);
  for (const name of [
    "@stll/mobile",
    "@stll/web",
    "@stll/api",
    "expo",
    "expo-router",
    "react-native",
  ]) {
    expect(installed.has(name), name).toBe(false);
  }
  for (const name of [
    "@stll/ui",
    "@tauri-apps/cli",
    "@tailwindcss/vite",
    "@vitejs/plugin-react",
    "vite",
    "react",
  ]) {
    expect(installed.has(name), name).toBe(true);
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

const assertScopedBrowserWorkspaces = (source: unknown) => {
  const { jobs } = v.parse(
    v.object({
      jobs: v.record(
        v.string(),
        v.looseObject({
          env: v.optional(v.record(v.string(), v.unknown()), {}),
          uses: v.optional(v.string()),
        }),
      ),
    }),
    source,
  );
  let checked = 0;
  for (const [job, configuration] of Object.entries(jobs)) {
    if (configuration.uses !== undefined) {
      continue;
    }
    let selectedDirectory: string | undefined;
    for (const step of workflowJobSteps(source, job)) {
      if (step["uses"] === "./.github/actions/setup-playwright") {
        const inputs = v.parse(
          v.optional(v.record(v.string(), v.unknown()), {}),
          step["with"],
        );
        selectedDirectory = v.parse(
          v.optional(v.string()),
          inputs["package-directory"],
        );
      }
      if (
        selectedDirectory === undefined ||
        typeof step["run"] !== "string" ||
        !step["run"].includes("setup-playwright/run-in-image.sh")
      ) {
        continue;
      }
      const environment = v.parse(
        v.optional(v.record(v.string(), v.unknown()), {}),
        step["env"],
      );
      const directory =
        environment["PLAYWRIGHT_PACKAGE_DIR"] ??
        configuration.env["PLAYWRIGHT_PACKAGE_DIR"];
      expect(
        directory,
        `${job}/${v.parse(v.optional(v.string(), "unnamed"), step["name"])} browser workspace`,
      ).toBe(selectedDirectory);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(0);
};

test("every image invocation after scoped browser setup retains its workspace", () => {
  assertScopedBrowserWorkspaces(workflow);
});

test("the workflow guard rejects missing or mismatched browser workspace propagation", () => {
  for (const directory of [undefined, "apps/web"]) {
    const fixture = {
      jobs: {
        browser: {
          steps: [
            {
              uses: "./.github/actions/setup-playwright",
              with: { "package-directory": "apps/landing" },
            },
            {
              name: "First browser tests",
              run: "bash .github/actions/setup-playwright/run-in-image.sh bun test",
              env: { PLAYWRIGHT_PACKAGE_DIR: "apps/landing" },
            },
            {
              name: "Browser tests",
              run: "bash .github/actions/setup-playwright/run-in-image.sh bun test",
              env: { PLAYWRIGHT_PACKAGE_DIR: directory },
            },
          ],
        },
      },
    };
    expect(() => assertScopedBrowserWorkspaces(fixture)).toThrow(
      "browser/Browser tests browser workspace",
    );
  }
});

test("landing verification and failure diagnostics use its installed workspace", () => {
  const steps = workflowJobSteps(workflow, "e2e-landing");
  const setup = v.parse(
    v.object({ with: v.record(v.string(), v.string()) }),
    steps.find((step) => step["uses"] === "./.github/actions/setup-playwright"),
  );
  expect(setup.with["package-directory"]).toBe("apps/landing");
  const diagnostics = v.parse(
    v.object({ with: v.object({ path: v.string() }) }),
    steps.find((step) => step["name"] === "Upload failure diagnostics"),
  );
  expect(diagnostics.with.path.split("\n")).toContain(
    "apps/landing/test-results/",
  );
  const action = v.parse(
    v.object({
      inputs: v.object({
        "package-directory": v.object({ default: v.string() }),
      }),
      runs: v.object({
        steps: v.array(v.object({ env: v.record(v.string(), v.string()) })),
      }),
    }),
    Bun.YAML.parse(
      readFileSync(
        path.join(root, ".github/actions/setup-playwright/action.yml"),
        "utf-8",
      ),
    ),
  );
  expect(action.inputs["package-directory"].default).toBe("apps/web");
  for (const step of action.runs.steps) {
    expect(step.env["PLAYWRIGHT_PACKAGE_DIR"]).toBe(
      `\${{ inputs.package-directory }}`,
    );
  }
});

test("browser verification resolves the selected workspace without a web install", () => {
  const directory = realpathSync(
    mkdtempSync(path.join(tmpdir(), "scoped-playwright-")),
  );
  const verifier = path.join(
    root,
    ".github/actions/setup-playwright/verify-browsers.sh",
  );
  try {
    mkdirSync(path.join(directory, "bin"));
    writeFileSync(
      path.join(directory, "bin/bun"),
      '#!/usr/bin/env bash\nprintf "verification cwd: %s\\n" "$PWD"\n',
      { mode: 0o755 },
    );
    // GNU realpath can resolve a missing final path component.
    writeFileSync(
      path.join(directory, "bin/realpath"),
      '#!/usr/bin/env bash\nprintf "%s/%s\\n" "$PWD" "$1"\n',
      { mode: 0o755 },
    );
    for (const workspace of ["apps/web", "apps/landing"]) {
      const packageDirectory = path.join(
        directory,
        workspace,
        "node_modules/@playwright/test",
      );
      mkdirSync(packageDirectory, { recursive: true });
      const env = {
        ...process.env,
        PATH: `${directory}/bin:${process.env["PATH"] ?? ""}`,
        GITHUB_WORKSPACE: directory,
        PLAYWRIGHT_PACKAGE_DIR: workspace,
      };
      const verified = Bun.spawnSync(["bash", verifier], { env });
      expect(verified.exitCode, verified.stderr.toString()).toBe(0);
      expect(verified.stdout.toString()).toContain(
        `verification cwd: ${directory}/${workspace}`,
      );
      rmSync(packageDirectory, { recursive: true });
      const missing = Bun.spawnSync(["bash", verifier], { env });
      expect(missing.exitCode).not.toBe(0);
      expect(missing.stderr.toString()).toContain(
        "Playwright is not installed",
      );
      expect(missing.stdout.toString()).not.toContain("verification cwd:");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("landing diagnostics follow the browser configuration output directory", () => {
  const directory = realpathSync(
    mkdtempSync(path.join(tmpdir(), "scoped-playwright-config-")),
  );
  const configDirectory = path.join(directory, "packages/playwright-tools/src");
  const sdkDirectory = path.join(directory, "node_modules/@playwright/test");
  try {
    mkdirSync(configDirectory, { recursive: true });
    mkdirSync(sdkDirectory, { recursive: true });
    // Only the SDK's configuration wrapper is replaced; execute the real owner.
    writeFileSync(
      path.join(sdkDirectory, "package.json"),
      JSON.stringify({
        name: "@playwright/test",
        type: "module",
        exports: "./config.js",
      }),
    );
    writeFileSync(
      path.join(sdkDirectory, "config.js"),
      'export const defineConfig = (value) => value; export const devices = { "Desktop Chrome": {} };',
    );
    for (const file of ["marketing-config.ts", "env.ts"]) {
      writeFileSync(
        path.join(configDirectory, file),
        readFileSync(
          path.join(root, "packages/playwright-tools/src", file),
          "utf-8",
        ),
      );
    }
    const result = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        'import { marketingConfig } from "./packages/playwright-tools/src/marketing-config.ts"; console.log(JSON.stringify(marketingConfig({ testDir: ".", project: "landing" })));',
      ],
      { cwd: directory },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const config = v.parse(
      v.object({ outputDir: v.string() }),
      JSON.parse(result.stdout.toString()),
    );
    const artifacts = v.parse(
      v.object({ with: v.object({ path: v.string() }) }),
      workflowJobSteps(workflow, "e2e-landing").find(
        (step) => step["name"] === "Upload failure diagnostics",
      ),
    );
    expect(artifacts.with.path.split("\n")).toContain(
      `${path.relative(directory, config.outputDir)}/`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

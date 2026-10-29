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

import { isPathInside } from "@stll/portable-path";

import { repoRelativePath } from "../packages/portable-path/src/index";
import { lexShell } from "./install-free-ci";
import { flattenWorkflowSteps, workflowJobSteps } from "./workflow-steps";

const root = path.resolve(import.meta.dirname, "..");
const workflow: unknown = Bun.YAML.parse(
  readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf-8"),
);
const targets = {
  "e2e-report": ["@stll/playwright-tools", "!stella"],
  "desktop-windows-dry-run": [
    "@stll/scripts...",
    "@stll/desktop...",
    "!stella",
  ],
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

const installFilters = (command: string) => {
  const invocations = [...lexShell(command)]
    .filter((event) => event.type === "command")
    .map(({ words }) => words.slice(words.indexOf("bun")))
    .filter(
      (words) =>
        words.at(0) === "bun" &&
        (words.at(1) === "ci" || words.at(1) === "scripts/ci-install.ts"),
    );
  expect(invocations).toHaveLength(1);
  const words = invocations.at(0) ?? [];
  expect(words).toContain("--frozen-lockfile");
  expect(words).toContain("--ignore-scripts");
  return words.flatMap((word, index) =>
    word === "--filter" ? [words.at(index + 1)] : [],
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

const workspaceDirectories = new Map(
  [
    ...new Bun.Glob("{apps,packages}/*/package.json").scanSync({ cwd: root }),
  ].map((file) => [
    path.dirname(file),
    v.parse(
      manifestSchema,
      JSON.parse(readFileSync(path.join(root, file), "utf-8")),
    ).name,
  ]),
);

const selectedWorkspaces = (filters: readonly string[]) => {
  if (filters.length === 0) {
    return new Set(manifests.keys());
  }
  const matches = (selector: string) => {
    const pattern = selector.replace(/\.\.\.$/u, "");
    const glob = new Bun.Glob(pattern);
    const names = [...manifests.keys()].filter((name) => glob.match(name));
    expect(
      names.length,
      `Unknown workspace filter ${selector}`,
    ).toBeGreaterThan(0);
    return names;
  };
  const included = filters.filter((filter) => !filter.startsWith("!"));
  const installed = closure(
    included.length === 0 ? [...manifests.keys()] : included.flatMap(matches),
  );
  for (const filter of filters.filter((value) => value.startsWith("!"))) {
    for (const name of matches(filter.slice(1))) {
      installed.delete(name);
    }
  }
  return installed;
};

const scopedFlags = (step: Record<string, unknown>) => {
  if (
    ["$/.github/actions/ci-install", "./.github/actions/ci-install"].includes(
      v.parse(v.optional(v.string(), ""), step["uses"]),
    )
  ) {
    return actionFlags(step);
  }
  if (typeof step["run"] !== "string") {
    return undefined;
  }
  for (const event of lexShell(step["run"])) {
    if (
      event.type !== "command" ||
      event.words.includes("-g") ||
      event.words.includes("--global")
    ) {
      continue;
    }
    const owner = event.words.findIndex((word) =>
      word.endsWith("/ci-install.ts"),
    );
    if (owner !== -1) {
      return event.words.slice(owner + 2);
    }
  }
  return undefined;
};

const scopedInstallCoverageProblems = (source: unknown) => {
  const defaultsSchema = v.object({
    run: v.optional(
      v.object({
        "working-directory": v.optional(v.string(), "."),
      }),
      { "working-directory": "." },
    ),
  });
  const { jobs, defaults } = v.parse(
    v.object({
      jobs: v.record(v.string(), v.unknown()),
      defaults: v.optional(defaultsSchema, {
        run: { "working-directory": "." },
      }),
    }),
    source,
  );
  const problems: string[] = [];
  for (const [job, value] of Object.entries(jobs)) {
    const configuration = v.parse(
      v.looseObject({
        steps: v.optional(v.array(v.unknown())),
        defaults: v.optional(defaultsSchema, defaults),
      }),
      value,
    );
    if (configuration.steps === undefined) {
      continue;
    }
    const steps = flattenWorkflowSteps(configuration.steps);
    const installIndex = steps.findIndex(
      (step) => scopedFlags(step) !== undefined,
    );
    if (installIndex === -1) {
      continue;
    }
    const install = steps.at(installIndex);
    if (install === undefined) {
      expect.unreachable("Missing indexed install");
    }
    const installed = selectedWorkspaces(
      v.parse(
        v.array(v.string()),
        filtersFromFlags(v.parse(v.array(v.string()), scopedFlags(install))),
      ),
    );
    const directoryScopes = new Map([[root, installed]]);
    const requireDirectory = (directory: string, step: string) => {
      const normalized = path.resolve(
        root,
        directory.replaceAll(
          /\$\{\{\s*github\.workspace\s*\}\}|\$(?:GITHUB_WORKSPACE|\{GITHUB_WORKSPACE\})/gu,
          () => root,
        ),
      );
      for (const [candidate, name] of workspaceDirectories) {
        const absolute = path.join(root, candidate);
        if (isPathInside(absolute, normalized) && !installed.has(name)) {
          problems.push(`${job}/${step}: ${name} is outside the install scope`);
        }
      }
    };
    const inspectStep = (
      step: Record<string, unknown>,
      defaultDirectory: string,
    ) => {
      const name = v.parse(v.optional(v.string(), "unnamed"), step["name"]);
      let directory = v.parse(
        v.optional(v.string(), defaultDirectory),
        step["working-directory"],
      );
      if (typeof step["working-directory"] === "string") {
        requireDirectory(directory, name);
      }
      const uses = step["uses"];
      if (
        [
          "$/.github/actions/ci-install",
          "./.github/actions/ci-install",
        ].includes(v.parse(v.optional(v.string(), ""), uses))
      ) {
        const scope = selectedWorkspaces(
          v.parse(v.array(v.string()), filtersFromFlags(actionFlags(step))),
        );
        const location = path.resolve(root, directory);
        const existing = directoryScopes.get(location) ?? new Set<string>();
        for (const selected of scope) {
          existing.add(selected);
        }
        directoryScopes.set(location, existing);
        return;
      }
      if (
        typeof uses === "string" &&
        /^(?:\$|\.)\/\.github\/actions\//u.test(uses)
      ) {
        const action = v.parse(
          v.object({
            inputs: v.optional(
              v.record(
                v.string(),
                v.object({ default: v.optional(v.string(), "") }),
              ),
              {},
            ),
            // A node action runs one entry point; only composite actions have steps.
            runs: v.variant("using", [
              v.object({
                using: v.literal("composite"),
                steps: v.array(v.unknown()),
              }),
              v.object({ using: v.picklist(["node20", "node24"]) }),
            ]),
          }),
          Bun.YAML.parse(
            readFileSync(path.join(root, uses.slice(2), "action.yml"), "utf-8"),
          ),
        );
        const inputs = v.parse(
          v.optional(v.record(v.string(), v.unknown()), {}),
          step["with"],
        );
        if (uses.endsWith("/setup-playwright")) {
          requireDirectory(
            v.parse(
              v.string(),
              inputs["package-directory"] ??
                action.inputs["package-directory"]?.default,
            ),
            name,
          );
        }
        const actionSteps =
          action.runs.using === "composite" ? action.runs.steps : [];
        for (const child of flattenWorkflowSteps(actionSteps)) {
          const expanded = { ...child };
          for (const key of ["run", "working-directory"]) {
            const text = expanded[key];
            if (typeof text !== "string") {
              continue;
            }
            expanded[key] = text.replace(
              /\$\{\{\s*inputs\.([\w-]+)\s*\}\}/gu,
              (_match, input: string) =>
                v.parse(
                  v.string(),
                  inputs[input] ?? action.inputs[input]?.default,
                ),
            );
          }
          inspectStep(expanded, directory);
        }
      }
      if (typeof step["run"] !== "string") {
        return;
      }
      const directoryStack: string[] = [];
      const environment = v.parse(
        v.optional(v.record(v.string(), v.unknown()), {}),
        step["env"],
      );
      if (typeof environment["PLAYWRIGHT_PACKAGE_DIR"] === "string") {
        requireDirectory(environment["PLAYWRIGHT_PACKAGE_DIR"], name);
      }
      for (const event of lexShell(step["run"])) {
        if (event.type === "subshell-start") {
          directoryStack.push(directory);
        }
        if (event.type === "subshell-end") {
          directory = directoryStack.pop() ?? directory;
        }
        if (event.type !== "command") {
          continue;
        }
        const { words } = event;
        if (words.at(0) === "cd" && words.at(1) !== undefined) {
          directory = path.resolve(
            root,
            directory,
            v.parse(v.string(), words.at(1)),
          );
        }
        const bunIndex = words.findIndex((word) =>
          ["bun", "bunx", "npx"].includes(word),
        );
        if (bunIndex === -1) {
          continue;
        }
        const command = words.slice(bunIndex + 1);
        // Pruned image checks perform a separate frozen install in their tree.
        // Install selectors declare that tree; they are not task consumers.
        if (
          command.some(
            (word) =>
              word.endsWith("/ci-install.ts") ||
              word === "install" ||
              word === "ci",
          )
        ) {
          if (command.includes("-g") || command.includes("--global")) {
            continue;
          }
          const filters = command.flatMap((word, index) => {
            if (word === "--filter") {
              return [v.parse(v.string(), command.at(index + 1))];
            }
            if (word.startsWith("--filter=")) {
              return [word.slice(9)];
            }
            return [];
          });
          const location = path.resolve(root, directory);
          const existing = directoryScopes.get(location) ?? new Set<string>();
          for (const selected of selectedWorkspaces(filters)) {
            existing.add(selected);
          }
          directoryScopes.set(location, existing);
          continue;
        }
        const commandScope =
          directoryScopes.get(path.resolve(root, directory)) ?? installed;
        for (const [index, word] of command.entries()) {
          if (word === "--cwd" || word.startsWith("--cwd=")) {
            requireDirectory(
              path.resolve(
                root,
                directory,
                v.parse(
                  v.string(),
                  word === "--cwd" ? command.at(index + 1) : word.slice(6),
                ),
              ),
              name,
            );
          }
          if (word === "--filter" || word.startsWith("--filter=")) {
            const selector = v.parse(
              v.string(),
              word === "--filter" ? command.at(index + 1) : word.slice(9),
            );
            for (const selected of selectedWorkspaces([selector])) {
              if (manifests.has(selected) && !commandScope.has(selected)) {
                problems.push(
                  `${job}/${name}: ${selected} is outside the install scope`,
                );
              }
            }
          }
          // File arguments (for example a source path passed to a selector)
          // do not execute in that workspace. Only Bun's entrypoint does.
          if (index === 0 && /^(?:apps|packages)\//u.test(word)) {
            requireDirectory(path.resolve(root, directory, word), name);
          }
        }
        requireDirectory(directory, name);
      }
    };
    for (const step of steps.slice(installIndex + 1)) {
      inspectStep(step, configuration.defaults.run["working-directory"]);
    }
  }
  return problems;
};

test("every scoped install covers later workspace commands and browser paths regardless of event", () => {
  expect(scopedInstallCoverageProblems(workflow)).toEqual([]);
});

test("the scope census rejects omitted workspaces in merge-only and scheduled jobs", () => {
  for (const consumer of [
    { run: "bun test", "working-directory": "apps/web" },
    { run: "bun --cwd=apps/web test" },
    { run: "bun --cwd apps/web test" },
    { run: "bun --filter @stll/web test:e2e" },
    { run: "cd apps/web\nbun test" },
    { uses: "./.github/actions/setup-playwright" },
    {
      uses: "./.github/actions/setup-playwright",
      with: { "package-directory": "apps/web" },
    },
  ]) {
    const fixture = {
      on: ["merge_group", "schedule"],
      jobs: {
        browser: {
          if: "github.event_name != 'pull_request'",
          steps: [
            {
              uses: "./.github/actions/ci-install",
              with: {
                flags:
                  '["--frozen-lockfile","--ignore-scripts","--filter","@stll/scripts"]',
              },
            },
            consumer,
          ],
        },
      },
    };
    expect(scopedInstallCoverageProblems(fixture)).toContain(
      "browser/unnamed: @stll/web is outside the install scope",
    );
  }
});

test("later browser jobs inherit the exact installed global store", () => {
  const action = Bun.YAML.parse(
    readFileSync(
      path.join(root, ".github/actions/ci-install/action.yml"),
      "utf-8",
    ),
  );
  const parsed = v.parse(
    v.object({ runs: v.object({ steps: v.array(v.unknown()) }) }),
    action,
  );
  const step = flattenWorkflowSteps(parsed.runs.steps).find(
    (candidate) => candidate["id"] === "restore-time",
  );
  const script = v.parse(v.string(), step?.["run"]);
  const temporary = mkdtempSync(path.join(tmpdir(), "ci-store-export-"));
  try {
    const store = path.join(realpathSync(temporary), "scoped-store");
    const environment = path.join(temporary, "env");
    writeFileSync(environment, "");
    const result = Bun.spawnSync(["bash", "-e", "-c", script], {
      env: {
        ...process.env,
        BUN_INSTALL_CACHE_DIR: store,
        CACHE_HIT: "false",
        START_MS: "0",
        GITHUB_ENV: environment,
        GITHUB_OUTPUT: path.join(temporary, "output"),
      },
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    let checked = 0;
    const missingStores: string[] = [];
    for (const [job, value] of Object.entries(
      v.parse(v.object({ jobs: v.record(v.string(), v.unknown()) }), workflow)
        .jobs,
    )) {
      const configuration = v.parse(
        v.looseObject({ steps: v.optional(v.array(v.unknown())) }),
        value,
      );
      if (configuration.steps === undefined) {
        continue;
      }
      const steps = flattenWorkflowSteps(configuration.steps);
      if (
        !steps.some(
          (candidate) => candidate["uses"] === "$/.github/actions/ci-install",
        ) ||
        !steps.some(
          (candidate) =>
            candidate["uses"] === "./.github/actions/setup-playwright" ||
            (typeof candidate["run"] === "string" &&
              candidate["run"].includes("setup-playwright/run-in-image.sh")),
        )
      ) {
        continue;
      }
      if (
        !readFileSync(environment, "utf-8").includes(
          `BUN_INSTALL_CACHE_DIR=${store}\n`,
        )
      ) {
        missingStores.push(
          `${job}: later browser cache is outside the installed store`,
        );
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    expect(missingStores).toEqual([]);
    const cache = Bun.spawnSync([process.execPath, "pm", "cache"], {
      env: { ...process.env, BUN_INSTALL_CACHE_DIR: store },
    });
    expect(cache.exitCode, cache.stderr.toString()).toBe(0);
    expect(cache.stdout.toString().trim()).toBe(store);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

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
      'export const defineConfig = (...configs) => Object.assign({}, ...configs); export const devices = { "Desktop Chrome": {} };',
    );
    for (const file of [
      "marketing-config.ts",
      "landing-marketing-config.ts",
      "devices.ts",
      "devices.gen.ts",
      "env.ts",
    ]) {
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
        'import config from "./packages/playwright-tools/src/landing-marketing-config.ts"; console.log(JSON.stringify(config));',
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
      `${repoRelativePath(directory, config.outputDir)}/`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const workflowFile = (file: string): unknown =>
  Bun.YAML.parse(readFileSync(path.join(root, file), "utf-8"));

test("the dependency audit installs only the root workspace", () => {
  const install = workflowJobSteps(
    workflowFile(".github/workflows/dependency-audit.yml"),
    "audit",
  ).find((step) => step["name"] === "Install dependencies");
  const command = v.parse(v.string(), install?.["run"]);
  expect(installFilters(command)).toEqual(["stella"]);
  expect(closure(["stella"]).has("@stll/api")).toBe(false);
});

const installFreeJobs = [
  [".github/workflows/autofix.yml", "regenerate-scope"],
] as const;
const setupSchema = v.looseObject({
  uses: v.string(),
  with: v.looseObject({ "no-cache": v.literal(true) }),
});
const installCommand = /\bbun (?:ci|i|install)\b/u;

for (const [file, job] of installFreeJobs) {
  test(`${job} sets up Bun without restoring the package cache`, () => {
    const steps = workflowJobSteps(workflowFile(file), job);
    const setups = steps.filter(
      (step) =>
        typeof step["uses"] === "string" && step["uses"].includes("setup-bun"),
    );
    expect(setups).toHaveLength(1);
    const setup = v.parse(setupSchema, setups.at(0));
    expect(setup.uses).toStartWith("oven-sh/setup-bun@");
    const installs = steps.filter(
      (step) =>
        typeof step["run"] === "string" && installCommand.test(step["run"]),
    );
    expect(installs).toEqual([]);
  });
}

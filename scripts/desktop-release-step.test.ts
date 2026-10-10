import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  configureWindowsSigning,
  desktopArtifacts,
  resignWindowsArtifacts,
  stampDesktopRelease,
} from "./desktop-release-step";

const githubExpression = (body: string): string => `\${{ ${body} }}`;

const releaseWorkflow = readFileSync(
  new URL("../.github/workflows/release-desktop.yml", import.meta.url),
  "utf-8",
);

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const temporary = (): string =>
  path.join(
    process.env["TMPDIR"] ?? "/tmp",
    `desktop-release-${crypto.randomUUID()}`,
  );

const releaseToolingViolations = (workflowSource: string): string[] => {
  const workflow = Bun.YAML.parse(workflowSource);
  if (!record(workflow) || !record(workflow["jobs"])) {
    return ["release workflow has no jobs"];
  }
  const violations: string[] = [];
  for (const [jobName, rawJob] of Object.entries(workflow["jobs"])) {
    const steps = record(rawJob) ? rawJob["steps"] : undefined;
    if (!Array.isArray(steps)) {
      continue;
    }
    const releaseCheckoutIndex = steps.findIndex((rawStep) => {
      if (!record(rawStep) || !record(rawStep["with"])) {
        return false;
      }
      return (
        rawStep["with"]["ref"] ===
        githubExpression("needs.resolve.outputs.release_sha")
      );
    });
    const toolingStepIndexes = steps.flatMap((rawStep, index) => {
      if (index <= releaseCheckoutIndex) {
        return [];
      }
      if (!record(rawStep)) {
        return [];
      }
      const run = typeof rawStep["run"] === "string" ? rawStep["run"] : "";
      const uses = typeof rawStep["uses"] === "string" ? rawStep["uses"] : "";
      return run.includes("desktop-release-step.ts") ||
        uses.includes("desktop-windows-build")
        ? [index]
        : [];
    });
    if (releaseCheckoutIndex === -1 || toolingStepIndexes.length === 0) {
      continue;
    }

    const beforeCheckout = steps.slice(0, releaseCheckoutIndex);
    const toolingCheckout = beforeCheckout.some((rawStep) => {
      if (!record(rawStep) || !record(rawStep["with"])) {
        return false;
      }
      const sparseCheckout = rawStep["with"]["sparse-checkout"];
      return (
        rawStep["with"]["ref"] === githubExpression("github.workflow_sha") &&
        typeof sparseCheckout === "string" &&
        sparseCheckout.includes("scripts/desktop-release-step.ts") &&
        sparseCheckout.includes(".github/actions/desktop-windows-build/")
      );
    });
    if (!toolingCheckout) {
      violations.push(`${jobName}: workflow tooling is not checked out`);
    }
    const preserved = beforeCheckout.some((rawStep) => {
      if (!record(rawStep) || typeof rawStep["run"] !== "string") {
        return false;
      }
      return (
        rawStep["run"].includes("$RUNNER_TEMP/release-tooling") &&
        rawStep["run"].includes("RELEASE_TOOLING=") &&
        rawStep["run"].includes("desktop-release-step.ts") &&
        rawStep["run"].includes("desktop-windows-build")
      );
    });
    if (!preserved) {
      violations.push(`${jobName}: tooling is not preserved before checkout`);
    }

    for (const index of toolingStepIndexes) {
      const rawStep = steps[index];
      if (!record(rawStep)) {
        continue;
      }
      const run = typeof rawStep["run"] === "string" ? rawStep["run"] : "";
      const uses = typeof rawStep["uses"] === "string" ? rawStep["uses"] : "";
      if (
        run.includes("desktop-release-step.ts") &&
        !run.includes("$RELEASE_TOOLING/scripts/desktop-release-step.ts")
      ) {
        violations.push(`${jobName}: script does not use preserved tooling`);
      }
      if (
        uses.includes("desktop-windows-build") &&
        uses !== "./.release-tooling/desktop-windows-build"
      ) {
        violations.push(`${jobName}: action does not use restored tooling`);
      }
      if (uses.includes("desktop-windows-build")) {
        const actionRestored = steps
          .slice(releaseCheckoutIndex + 1, index)
          .some(
            (candidate) =>
              record(candidate) &&
              typeof candidate["run"] === "string" &&
              candidate["run"].includes(
                "$RELEASE_TOOLING/actions/desktop-windows-build",
              ) &&
              candidate["run"].includes(
                ".release-tooling/desktop-windows-build",
              ),
          );
        if (!actionRestored) {
          violations.push(`${jobName}: action is not restored after checkout`);
        }
      }
    }
  }
  return violations;
};

test("release script steps follow source checkout and Bun setup", () => {
  const workflow = Bun.YAML.parse(releaseWorkflow);
  expect(record(workflow)).toBe(true);
  if (!record(workflow)) {
    return;
  }
  const jobs = workflow["jobs"];
  expect(record(jobs)).toBe(true);
  if (!record(jobs)) {
    return;
  }

  for (const [jobName, rawJob] of Object.entries(jobs)) {
    const steps = record(rawJob) ? rawJob["steps"] : undefined;
    if (!Array.isArray(steps)) {
      continue;
    }
    let sourceCheckout = false;
    let bunSetup = false;
    for (const rawStep of steps) {
      if (!record(rawStep)) {
        continue;
      }
      const step = rawStep;
      const uses = step["uses"];
      const inputs = record(step["with"]) ? step["with"] : undefined;
      if (
        typeof uses === "string" &&
        uses.startsWith("actions/checkout@") &&
        inputs?.["path"] === undefined
      ) {
        sourceCheckout = true;
      }
      if (typeof uses === "string" && uses.startsWith("oven-sh/setup-bun@")) {
        bunSetup = true;
      }
      if (
        typeof step["run"] === "string" &&
        /\bbun\s+scripts\//u.test(step["run"])
      ) {
        expect(sourceCheckout, `${jobName}: ${String(step["name"])}`).toBe(
          true,
        );
        expect(bunSetup, `${jobName}: ${String(step["name"])}`).toBe(true);
      }
    }
  }
});

test("release jobs preserve workflow tooling before checking out release source", () => {
  expect(releaseToolingViolations(releaseWorkflow)).toEqual([]);

  const brokenWorkflow = releaseWorkflow
    .replace(
      'bun "$RELEASE_TOOLING/scripts/desktop-release-step.ts" stamp',
      "bun scripts/desktop-release-step.ts stamp",
    )
    .replace(
      "uses: ./.release-tooling/desktop-windows-build",
      "uses: ./.github/actions/desktop-windows-build",
    );
  expect(releaseToolingViolations(brokenWorkflow)).toEqual([
    "build: script does not use preserved tooling",
    "build: action does not use restored tooling",
  ]);
});

test("the preserved release script imports only Node built-ins", () => {
  const script = readFileSync(
    new URL("desktop-release-step.ts", import.meta.url),
    "utf-8",
  );
  const imports = [...script.matchAll(/from\s+["']([^"']+)["']/gu)].map(
    (match) => match[1],
  );
  expect(imports.length).toBeGreaterThan(0);
  expect(imports.every((specifier) => specifier?.startsWith("node:"))).toBe(
    true,
  );
});

test("the Windows build action receives its release script path explicitly", () => {
  const action = readFileSync(
    new URL(
      "../.github/actions/desktop-windows-build/action.yml",
      import.meta.url,
    ),
    "utf-8",
  );
  const commands = action
    .split("\n")
    .filter((line) => line.includes("desktop-release-step.ts"));
  expect(commands).toEqual([
    "    description: Path to desktop-release-step.ts",
  ]);
  expect(action.match(/bun "\$\{\{ inputs\.script-path \}\}"/gu)?.length).toBe(
    2,
  );
  expect(action).not.toMatch(
    /bun (?:\.\.\/)*scripts\/desktop-release-step\.ts/u,
  );
});

test("stamps the version into both files and pins the channel endpoint", () => {
  const root = temporary();
  mkdirSync(path.join(root, "apps/desktop/src-tauri"), { recursive: true });
  writeFileSync(
    path.join(root, "apps/desktop/src-tauri/tauri.conf.json"),
    '{"version":"0.1.0","plugins":{"updater":{"endpoints":[]}}}',
  );
  writeFileSync(
    path.join(root, "apps/desktop/src-tauri/Cargo.toml"),
    'version = "0.1.0"\n',
  );
  stampDesktopRelease(root, "2.3.4", "beta");
  expect(
    readFileSync(
      path.join(root, "apps/desktop/src-tauri/tauri.conf.json"),
      "utf-8",
    ),
  ).toContain('"version": "2.3.4"');
  expect(
    readFileSync(
      path.join(root, "apps/desktop/src-tauri/tauri.conf.json"),
      "utf-8",
    ),
  ).toContain("/beta/latest.json");
  expect(
    readFileSync(path.join(root, "apps/desktop/src-tauri/Cargo.toml"), "utf-8"),
  ).toContain('version = "2.3.4"');
});

test("resigning skips an absent updater zip", () => {
  const bundle = temporary();
  mkdirSync(path.join(bundle, "nsis"), { recursive: true });
  writeFileSync(path.join(bundle, "nsis/Stella-setup.exe"), "installer");
  const signed: string[] = [];
  resignWindowsArtifacts(bundle, (_cwd, file) => {
    signed.push(file);
  });
  expect(signed).toEqual(["Stella-setup.exe"]);
});

test("resigning rejects an empty artifact directory", () => {
  const bundle = temporary();
  mkdirSync(bundle, { recursive: true });
  expect(() => resignWindowsArtifacts(bundle, () => undefined)).toThrow(
    "No Windows installers found",
  );
});

test("configure-windows rejects unknown modes", () => {
  const config = path.join(temporary(), "tauri.conf.json");
  mkdirSync(path.dirname(config), { recursive: true });
  writeFileSync(config, '{"bundle":{"windows":{}}}');
  expect(() => configureWindowsSigning(config, "other", {})).toThrow(
    "Unknown configure-windows mode",
  );
});

test("configure-windows dry-run disables signing and updater artifacts", () => {
  const config = path.join(temporary(), "tauri.conf.json");
  mkdirSync(path.dirname(config), { recursive: true });
  writeFileSync(
    config,
    readFileSync(
      new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url),
      "utf-8",
    ),
  );
  configureWindowsSigning(config, "dry-run", {});
  const result = JSON.parse(readFileSync(config, "utf-8"));
  expect(result.bundle.windows.signCommand).toBeUndefined();
  expect(result.bundle.createUpdaterArtifacts).toBe(false);
});

test("the CI dry-run selector covers every script referenced by the release workflow", () => {
  const references = [
    ...releaseWorkflow.matchAll(/(?:bash|bun)\s+(scripts\/[\w./-]+)/gu),
  ].map((match) => match[1]);
  expect(references.length).toBeGreaterThan(0);
  expect(
    references.every((reference) => reference?.startsWith("scripts/")),
  ).toBe(true);
  const ciWorkflow = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf-8",
  );
  expect(ciWorkflow).toContain("apps/desktop/*|scripts/*|");
});

test("artifact discovery is recursive, stable, and rejects unrelated files", () => {
  const bundle = temporary();
  mkdirSync(path.join(bundle, "nsis"), { recursive: true });
  writeFileSync(path.join(bundle, "nsis/Stella-windows.exe"), "installer");
  writeFileSync(path.join(bundle, "Stella-macos.dmg"), "installer");
  writeFileSync(path.join(bundle, "latest.json"), "{}");
  expect(desktopArtifacts(bundle)).toEqual([
    path.join(bundle, "Stella-macos.dmg"),
    path.join(bundle, "nsis/Stella-windows.exe"),
  ]);
  expect(desktopArtifacts(path.join(bundle, "missing"))).toEqual([]);
});

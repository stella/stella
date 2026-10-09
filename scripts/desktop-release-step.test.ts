import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  configureWindowsSigning,
  desktopArtifacts,
  resignWindowsArtifacts,
  stampDesktopRelease,
} from "./desktop-release-step";

const releaseWorkflow = readFileSync(
  new URL("../.github/workflows/release-desktop.yml", import.meta.url),
  "utf-8",
);

type RecordValue = Record<string, unknown>;

const record = (value: unknown): RecordValue | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;

const temporary = (): string =>
  path.join(
    process.env["TMPDIR"] ?? "/tmp",
    `desktop-release-${crypto.randomUUID()}`,
  );

test("release script steps follow source checkout and Bun setup", () => {
  const workflow = record(Bun.YAML.parse(releaseWorkflow));
  const jobs = record(workflow?.["jobs"]);
  expect(jobs).toBeDefined();

  for (const [jobName, rawJob] of Object.entries(jobs ?? {})) {
    const steps = record(rawJob)?.["steps"];
    if (!Array.isArray(steps)) {
      continue;
    }
    let sourceCheckout = false;
    let bunSetup = false;
    for (const rawStep of steps) {
      const step = record(rawStep);
      if (step === undefined) {
        continue;
      }
      const uses = step["uses"];
      const inputs = record(step["with"]);
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
  resignWindowsArtifacts(bundle, (_cwd, file) => signed.push(file));
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

import { panic } from "better-result";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  catalogGeneratorNetworkViolations,
  enumerateOfflineChecks,
  offlineCheckExceptionGrowth,
  offlineCheckViolations,
  parseOfflineCheckExceptions,
} from "./offline-check-policy";

const root = path.resolve(import.meta.dir, "..");
const exceptions = () =>
  parseOfflineCheckExceptions(
    JSON.parse(
      readFileSync(
        path.join(root, "scripts/offline-check-exceptions.json"),
        "utf-8",
      ),
    ),
  );
const workflow = (run: string) => ({ jobs: { checks: { steps: [{ run }] } } });

test("new check invocations cannot bypass the offline preload in nested shell or parallel steps", () => {
  for (const run of [
    "bun scripts/planted-check.ts --check",
    "result=$(bun scripts/planted-check.ts --check)",
    "bun scripts/planted-check.ts \\\n --check",
  ]) {
    const checks = enumerateOfflineChecks({
      jobs: { checks: { steps: [{ parallel: [{ run }] }] } },
    });
    expect(checks).toHaveLength(1);
    expect(offlineCheckViolations(checks, [])).toEqual([
      `Check must use the offline network preload: ${checks[0]?.command}`,
    ]);
  }
  const protectedChecks = enumerateOfflineChecks(
    workflow(
      "bun --preload ./scripts/offline-network-preload.ts scripts/planted-check.ts --check",
    ),
  );
  expect(protectedChecks).toHaveLength(1);
  expect(offlineCheckViolations(protectedChecks, [])).toEqual([]);
});

test("check exceptions are reasoned, shrink only, and cannot outlive the raw invocation", () => {
  const checks = enumerateOfflineChecks(
    workflow("bun scripts/planted-check.ts --check"),
  );
  const command = checks.at(0)?.command;
  if (command === undefined) {
    panic("Planted check was not enumerated");
  }
  const baseline = [{ command, reason: "Existing local verification" }];
  expect(offlineCheckViolations(checks, baseline)).toEqual([]);
  expect(offlineCheckViolations([], baseline)).toEqual([
    `Stale offline check exception: ${command}`,
  ]);
  expect(offlineCheckExceptionGrowth([], baseline)).toEqual([]);
  expect(offlineCheckExceptionGrowth(baseline, [])).toEqual([
    `Offline check exceptions may only shrink: ${command}`,
  ]);
  expect(() => parseOfflineCheckExceptions([{ command, reason: "" }])).toThrow(
    "Every offline check exception needs a command and reason",
  );
});

test("catalog generator enumeration confines newly introduced transports to the snapshot owner", () => {
  const clean = new Map([
    ["model-catalog-new-gen.ts", "await readSnapshot();"],
  ]);
  expect(catalogGeneratorNetworkViolations(clean, [])).toEqual([]);
  const planted = new Map([
    ["model-catalog-new-gen.ts", "await fetch('https://example.invalid');"],
  ]);
  expect(catalogGeneratorNetworkViolations(planted, [])).toEqual([
    "Catalog generator transport must be owned by model-catalog-snapshot.ts: Check must use the offline network preload: model-catalog-new-gen.ts",
  ]);
});

test("committed check invocations and catalog generator transports are exhaustively classified", () => {
  const checks = enumerateOfflineChecks(
    Bun.YAML.parse(
      readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf-8"),
    ),
  );
  expect(checks.length).toBeGreaterThan(0);
  expect(offlineCheckViolations(checks, exceptions())).toEqual([]);
  const sourceRoot = path.join(root, "packages/scripts/src");
  const sources = new Map(
    [
      ...new Bun.Glob("model-catalog-*-gen.ts").scanSync({ cwd: sourceRoot }),
    ].map((file) => [file, readFileSync(path.join(sourceRoot, file), "utf-8")]),
  );
  expect(sources.size).toBeGreaterThan(0);
  expect(catalogGeneratorNetworkViolations(sources, exceptions())).toEqual([]);
});

const runPreloaded = (code: string, mode: string) =>
  Bun.spawnSync(
    [
      process.execPath,
      "--preload",
      path.join(root, "scripts/offline-network-preload.ts"),
      "--eval",
      code,
      "--",
      mode,
    ],
    { cwd: root },
  );

test("the check preload denies every fetch invocation", () => {
  const planted = runPreloaded(
    "await fetch('data:text/plain,planted');",
    "--check",
  );
  expect(planted.exitCode).not.toBe(0);
  expect(planted.stderr.toString()).toContain(
    "Offline check attempted a network fetch",
  );
});

test("offline checks pass without transport and reject a planted network fetch before reaching upstream", () => {
  const clean = runPreloaded(
    "console.log('offline input verified');",
    "--check",
  );
  expect(clean.exitCode).toBe(0);
  expect(clean.stdout.toString()).toContain("offline input verified");
  const planted = runPreloaded(
    "await fetch('https://example.invalid');",
    "--check",
  );
  expect(planted.exitCode).not.toBe(0);
  expect(planted.stderr.toString()).toContain(
    "Offline check attempted a network fetch",
  );
  const swallowed = runPreloaded(
    "await Promise.resolve().then(() => fetch('https://example.invalid')).catch(() => {});",
    "--check",
  );
  expect(swallowed.exitCode).not.toBe(0);
  const refresh = runPreloaded(
    "console.log(await (await fetch('data:text/plain,refresh')).text());",
    "--refresh",
  );
  expect(refresh.exitCode).toBe(0);
  expect(refresh.stdout.toString()).toContain("refresh");
});

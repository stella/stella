#!/usr/bin/env bun

import path from "node:path";

import {
  assertPreCutGates,
  type CutGateRunner,
  productionCutGateEffects,
  readLatestFinalVersion,
  readReleaseDates,
  type ReleaseDates,
} from "./prepare-maintenance-release";
import {
  type PreCutGate,
  preCutGates,
} from "./prepare-maintenance-release-gates";

export type RehearsalResult = {
  readonly name: string;
  readonly status: "passed" | "failed" | "skipped";
  readonly detail?: string;
};

type RehearsalOptions = {
  readonly gates?: readonly PreCutGate[];
  readonly scope?: "all" | "token-free";
  readonly rootDir?: string;
  readonly runGate?: CutGateRunner;
  readonly resolveHeadSha?: () => string;
  readonly latestFinalVersion?: () => string;
  readonly readReleaseDates?: () => ReleaseDates;
  readonly write?: (text: string) => void;
};

export const runReleaseRehearsal = async ({
  gates = preCutGates(),
  scope = "all",
  rootDir = path.resolve(import.meta.dirname, ".."),
  ...injected
}: RehearsalOptions = {}): Promise<readonly RehearsalResult[]> => {
  const production = productionCutGateEffects(rootDir);
  const runGate = injected.runGate ?? production.runGate;
  const resolveHeadSha = injected.resolveHeadSha ?? production.resolveHeadSha;
  const latestFinalVersion =
    injected.latestFinalVersion ?? (() => readLatestFinalVersion(rootDir));
  const write = injected.write ?? production.write;
  const releaseDates =
    injected.readReleaseDates ?? (() => readReleaseDates(rootDir));
  const selected = gates.filter(
    ({ name }) => scope === "all" || name !== "deploy-env-contract",
  );
  const results: RehearsalResult[] = [];
  const rehearsalRunner: CutGateRunner = async (gate, context) => {
    const writeRefusal =
      gate.writeSide === undefined
        ? null
        : `dry-run refused write side: ${gate.writeSide}`;
    const outcome =
      writeRefusal === null
        ? await runGate(gate, context)
        : { passed: false as const, detail: writeRefusal };
    const skipped = !outcome.passed && gate.overriddenByAllowUnprovenMain;
    let status: RehearsalResult["status"] = "passed";
    if (!outcome.passed) {
      status = skipped ? "skipped" : "failed";
    }
    results.push({
      name: gate.name,
      status,
      ...(outcome.passed ? {} : { detail: outcome.detail }),
    });
    return outcome;
  };
  await assertPreCutGates({
    allowUnprovenMain: true,
    context: {
      baseSha: resolveHeadSha(),
      previousFinalTag: `v${latestFinalVersion()}`,
      // The rehearsal checks the snapshot as recorded, with no network refresh.
      releaseDates: releaseDates(),
      rootDir,
      write,
    },
    gates: selected,
    runGate: rehearsalRunner,
  }).catch((error: unknown) => {
    // A failed gate is already in the results; anything else must not pass.
    if (!results.some(({ status }) => status === "failed")) {
      throw error;
    }
  });
  return results;
};

if (import.meta.main) {
  const scope = process.argv.includes("--token-free") ? "token-free" : "all";
  const results = await runReleaseRehearsal({ scope });
  const failed = results.filter(({ status }) => status === "failed");
  const skipped = results.filter(({ status }) => status === "skipped");
  process.stdout.write(
    `release-rehearsal: ran ${results.map(({ name }) => name).join(", ")}\n`,
  );
  if (skipped.length > 0) {
    process.stdout.write(
      `release-rehearsal: --allow-unproven-main skipped ${skipped.map(({ name }) => name).join(", ")}\n`,
    );
  }
  if (failed.length > 0) {
    for (const { detail, name } of failed) {
      process.stderr.write(`::error::${name}: ${detail ?? "failed"}\n`);
    }
    process.exit(1);
  }
}

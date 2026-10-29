#!/usr/bin/env bun

import { panic } from "better-result";
import path from "node:path";

import {
  type PreCutGate,
  preCutGates,
} from "./prepare-maintenance-release-gates";

export type RehearsalResult = {
  readonly name: string;
  readonly status: "passed" | "failed";
  readonly detail?: string;
};

type RehearsalOptions = {
  readonly gates?: readonly PreCutGate[];
  readonly scope?: "all" | "token-free";
  readonly rootDir?: string;
  readonly run?: (command: readonly string[]) => Promise<number>;
};

const commandFor = (gate: PreCutGate): readonly string[] => {
  switch (gate.check.kind) {
    case "command":
      return gate.check.command;
    case "npm-publish-lag":
      return [
        "bun",
        "scripts/check-npm-publish-lag.ts",
        "--previous-release-of",
        "HEAD",
      ];
    case "main-statuses":
      return [
        "bash",
        "scripts/check-release-main-health.sh",
        process.env["GITHUB_REPOSITORY"] ?? "stella/stella",
        process.env["GITHUB_SHA"] ?? "HEAD",
        process.env["GITHUB_SHA"] ?? "HEAD",
      ];
    default:
      gate.check satisfies never;
      return panic("Unknown release gate check");
  }
};

const spawn = async (command: readonly string[], rootDir: string) => {
  const child = Bun.spawn([...command], {
    cwd: rootDir,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
};

export const runReleaseRehearsal = async ({
  gates = preCutGates(),
  scope = "all",
  rootDir = path.resolve(import.meta.dirname, ".."),
  run = async (command) => await spawn(command, rootDir),
}: RehearsalOptions = {}): Promise<readonly RehearsalResult[]> => {
  const selected = gates.filter(
    ({ name }) => scope === "all" || name !== "deploy-env-contract",
  );
  const results: RehearsalResult[] = [];
  for (const gate of selected) {
    if (gate.writeSide !== undefined) {
      results.push({
        name: gate.name,
        status: "failed",
        detail: `dry-run refused write side: ${gate.writeSide}`,
      });
      continue;
    }
    process.stdout.write(`release-rehearsal: ${gate.name}: check only\n`);
    const exitCode = await run(commandFor(gate));
    results.push({
      name: gate.name,
      status: exitCode === 0 ? "passed" : "failed",
      ...(exitCode === 0 ? {} : { detail: `exit ${String(exitCode)}` }),
    });
  }
  return results;
};

if (import.meta.main) {
  const scope = process.argv.includes("--token-free") ? "token-free" : "all";
  const results = await runReleaseRehearsal({ scope });
  const failed = results.filter(({ status }) => status === "failed");
  process.stdout.write(
    `release-rehearsal: ran ${results.map(({ name }) => name).join(", ")}\n`,
  );
  if (failed.length > 0) {
    for (const { detail, name } of failed) {
      process.stderr.write(`::error::${name}: ${detail ?? "failed"}\n`);
    }
    process.exit(1);
  }
}

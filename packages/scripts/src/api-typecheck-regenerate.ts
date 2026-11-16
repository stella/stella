#!/usr/bin/env bun
import { panic } from "better-result";
import path from "node:path";

import { childExitStatus } from "./child-exit-status";
import { writeTurboTypecheckInputs } from "./turbo-typecheck-inputs";
import {
  explicitTypecheckProjects,
  readTypecheckCacheTasks,
  typecheckCacheContractIssues,
  typecheckCacheCrossWorkspacePrograms,
} from "./typecheck-cache-contract";

export const API_TYPECHECK_REGENERATION_COMMANDS = [
  ["bun", "--cwd=packages/cli", "run", "codegen:runtime"],
  ["bun", "--cwd=apps/api", "run", "generate:capability-runtime"],
  [
    "bun",
    "--cwd=apps/api",
    "run",
    "generate:typecheck-declarations",
    "--write-surface",
  ],
  ["bun", "packages/scripts/src/api-typecheck-partition.ts", "--write"],
  ["bun", "packages/scripts/src/api-typecheck-partition.ts", "--resolved"],
] as const;

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, "../../..");
  for (const command of API_TYPECHECK_REGENERATION_COMMANDS) {
    const result = Bun.spawnSync([...command], {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    });
    const status = childExitStatus(result);
    if (status !== 0) {
      process.exit(status);
    }
  }
  const crossWorkspacePrograms =
    await typecheckCacheCrossWorkspacePrograms(root);
  const projects = explicitTypecheckProjects(root);
  const inputs = new Map<string, string[]>();
  for (const [name, task] of readTypecheckCacheTasks(root)) {
    if (!projects.has(name)) {
      continue;
    }
    if (!task.inputs) {
      panic(
        `Native compiler task must declare inputs before regeneration: ${name}`,
      );
    }
    const expected = task.inputs.filter(
      (input) => input !== "$TURBO_ROOT$/bun.lock",
    );
    if (crossWorkspacePrograms.has(name)) {
      expected.push("$TURBO_ROOT$/bun.lock");
    }
    // Preserve the canonical native census ordering for API tasks.
    if (
      JSON.stringify(expected.toSorted()) !==
      JSON.stringify(task.inputs.toSorted())
    ) {
      inputs.set(name, expected);
    }
  }
  if (inputs.size > 0) {
    writeTurboTypecheckInputs(path.join(root, "turbo.json"), inputs);
  }
  const issues = await typecheckCacheContractIssues(
    root,
    crossWorkspacePrograms,
  );
  if (issues.length > 0) {
    panic(issues.join("\n"));
  }
}

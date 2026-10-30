import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

import {
  type PreCutGate,
  preCutGates,
} from "./prepare-maintenance-release-gates";
import { runReleaseRehearsal } from "./release-rehearsal";

describe("release rehearsal", () => {
  const contextEffects = {
    latestFinalVersion: () => "1.2.3",
    resolveHeadSha: () => "0123456789abcdef0123456789abcdef01234567",
    write: () => undefined,
  };

  test("hands every pre-cut gate to the cut runner with the cut context", async () => {
    const calls: { gate: PreCutGate; context: unknown }[] = [];
    const results = await runReleaseRehearsal({
      ...contextEffects,
      rootDir: "/release-root",
      runGate: async (gate, context) => {
        calls.push({ gate, context });
        return { passed: true };
      },
    });

    expect(results.map(({ name }) => name)).toEqual(
      preCutGates().map(({ name }) => name),
    );
    expect(calls.map(({ gate }) => gate)).toEqual([...preCutGates()]);
    expect(calls.map(({ context }) => context)).toEqual(
      preCutGates().map(() => ({
        baseSha: "0123456789abcdef0123456789abcdef01234567",
        previousFinalTag: "v1.2.3",
        rootDir: "/release-root",
        write: contextEffects.write,
      })),
    );
  });

  test("refuses a gate reporting a write side in dry-run mode", async () => {
    const gate = {
      name: "write-test",
      source: "cut",
      stage: "pre-cut",
      check: { kind: "command", command: ["false"] },
      overriddenByAllowUnprovenMain: false,
      writeSide: "push a tag",
    } as const satisfies PreCutGate;
    let ran = false;
    const [result] = await runReleaseRehearsal({
      ...contextEffects,
      gates: [gate],
      runGate: async () => {
        ran = true;
        return { passed: true };
      },
    });

    expect(ran).toBe(false);
    expect(result).toEqual({
      name: "write-test",
      status: "failed",
      detail: "dry-run refused write side: push a tag",
    });
  });

  test("token-free scope omits only deploy-env-contract", async () => {
    const results = await runReleaseRehearsal({
      ...contextEffects,
      scope: "token-free",
      runGate: async () => ({ passed: true }),
    });
    expect(results.map(({ name }) => name)).toEqual(
      preCutGates()
        .filter(({ name }) => name !== "deploy-env-contract")
        .map(({ name }) => name),
    );
  });
});

test("rehearsals evaluate a tagged snapshot without requiring the latest main", async () => {
  const rootDir = mkdtempSync(
    path.join(import.meta.dir, "../.rehearsal-test-"),
  );
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", rootDir, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  try {
    git("init", "--initial-branch=main");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "snapshot",
    );
    git("-c", "tag.gpgsign=false", "tag", "v1.2.3");
    const snapshot = git("rev-parse", "HEAD");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "advance",
    );
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("checkout", "--detach", snapshot);
    expect(git("rev-parse", "HEAD")).not.toBe(git("rev-parse", "origin/main"));
    const contexts: unknown[] = [];
    const results = await runReleaseRehearsal({
      rootDir,
      resolveHeadSha: () => snapshot,
      write: () => undefined,
      runGate: async (_gate, context) => {
        contexts.push({
          baseSha: context.baseSha,
          previousFinalTag: context.previousFinalTag,
        });
        return { passed: true };
      },
    });
    expect(results.length).toBeGreaterThan(0);
    expect(contexts).toEqual(
      results.map(() => ({
        baseSha: snapshot,
        previousFinalTag: "v1.2.3",
      })),
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

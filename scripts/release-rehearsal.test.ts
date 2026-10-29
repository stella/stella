import { describe, expect, test } from "bun:test";

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

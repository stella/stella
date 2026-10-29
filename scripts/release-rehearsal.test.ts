import { describe, expect, test } from "bun:test";

import {
  type PreCutGate,
  preCutGates,
} from "./prepare-maintenance-release-gates";
import { runReleaseRehearsal } from "./release-rehearsal";

describe("release rehearsal", () => {
  test("runs every preCutGates entry", async () => {
    const commands: string[][] = [];
    const results = await runReleaseRehearsal({
      run: async (command) => {
        commands.push([...command]);
        return 0;
      },
    });

    expect(results.map(({ name }) => name)).toEqual(
      preCutGates().map(({ name }) => name),
    );
    expect(commands).toHaveLength(preCutGates().length);
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
      gates: [gate],
      run: async () => {
        ran = true;
        return 0;
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
      scope: "token-free",
      run: async () => 0,
    });
    expect(results.map(({ name }) => name)).toEqual(
      preCutGates()
        .filter(({ name }) => name !== "deploy-env-contract")
        .map(({ name }) => name),
    );
  });
});

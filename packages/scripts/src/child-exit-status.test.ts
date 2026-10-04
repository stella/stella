import { expect, test } from "bun:test";
import fc from "fast-check";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

import { assertProperty } from "@stll/property-testing";

import { childExitStatus } from "./child-exit-status";

test("child exit normalization preserves ordinary exit codes and rejects signals", () => {
  assertProperty(
    "child exit normalization preserves ordinary exit codes and rejects signals",
    fc.property(fc.integer({ min: 0, max: 255 }), (code) => {
      expect(childExitStatus(code)).toBe(code);
      expect(childExitStatus({ exitCode: code })).toBe(code);
      expect(childExitStatus({ status: code, signal: null })).toBe(code);
      expect(childExitStatus({ exitCode: code, signalCode: "SIGTERM" })).toBe(
        1,
      );
      expect(childExitStatus({ status: code, signal: "SIGTERM" })).toBe(1);
    }),
  );
});

test("missing, invalid and failed child results cannot become success", () => {
  for (const code of [
    null,
    undefined,
    Number.NaN,
    Infinity,
    -1,
    0.5,
    256,
    65_536,
  ]) {
    expect(childExitStatus(code)).toBe(1);
    expect(childExitStatus({ exitCode: code })).toBe(1);
  }
  expect(childExitStatus({ status: null, signal: null })).toBe(1);
  expect(childExitStatus({ exitCode: 0, error: "spawn failed" })).toBe(1);
  expect(childExitStatus({ exitCode: 0, signalCode: 15 })).toBe(1);
});

test("Bun spawn and spawnSync preserve a real child's normal status", async () => {
  for (const code of [0, 7]) {
    const command = [
      process.execPath,
      "--no-env-file",
      "-e",
      `process.exit(${code})`,
    ];
    expect(childExitStatus(Bun.spawnSync(command))).toBe(code);
    const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
    await child.exited;
    expect(childExitStatus(child)).toBe(code);
  }
});

test("Bun and Node signal-killed children produce a failing parent status", async () => {
  const bunChild = Bun.spawn(["sleep", "30"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    bunChild.kill("SIGTERM");
    await bunChild.exited;
    expect(bunChild.signalCode).toBe("SIGTERM");
    expect(childExitStatus(bunChild)).toBe(1);
  } finally {
    if (bunChild.exitCode === null && bunChild.signalCode === null) {
      bunChild.kill("SIGKILL");
      await bunChild.exited;
    }
  }

  const nodeChild = spawn("sleep", ["30"], { stdio: "ignore" });
  const exited = once(nodeChild, "exit");
  try {
    await once(nodeChild, "spawn");
    expect(nodeChild.kill("SIGTERM")).toBe(true);
    const [, signal] = await exited;
    expect(signal).toBe("SIGTERM");
    expect(childExitStatus(nodeChild)).toBe(1);
  } finally {
    if (nodeChild.exitCode === null && nodeChild.signalCode === null) {
      nodeChild.kill("SIGKILL");
      await exited;
    }
  }

  const syncChild = spawnSync("sleep", ["30"], {
    timeout: 20,
    killSignal: "SIGTERM",
  });
  expect(syncChild.signal).toBe("SIGTERM");
  expect(childExitStatus(syncChild)).toBe(1);
});

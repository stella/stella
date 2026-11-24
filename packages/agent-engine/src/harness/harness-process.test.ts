import { panic, Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import { createDetached } from "@stll/errors";
import { settledWithin } from "@stll/test-kit";

import { PROTOCOL_LOG_OFF } from "../protocol-log";
import {
  decodeStderrTail,
  startHarnessProcess,
  stderrTailSince,
} from "./harness-process";

const backgroundErrors: unknown[] = [];
afterEach(() => {
  expect(backgroundErrors.splice(0)).toEqual([]);
});

/** A harness that runs `script` in a shell, its handlers given here. */
const startShell = (
  script: string,
  handlers: {
    message?: (value: unknown) => void;
    violation?: (message: string) => void;
  } = {},
) => {
  const started = startHarnessProcess<number, Error>({
    command: ["/bin/sh", "-c", script],
    cwd: "/",
    env: { PATH: process.env["PATH"] ?? "" },
    detached: createDetached((error) => {
      backgroundErrors.push(error);
    }),
    deadlines: { requestMs: 30_000, terminateMs: 300 },
    name: "fake-harness",
    protocol: { channel: "codex", log: PROTOCOL_LOG_OFF },
    unanswered: (reason, message) => new Error(`${reason}: ${message}`),
    message: handlers.message ?? (() => undefined),
    violation: handlers.violation ?? (() => undefined),
    exit: () => undefined,
  });
  return Result.isOk(started)
    ? started.value
    : panic("the shell harness did not start");
};

describe.skipIf(process.platform === "win32")("a harness process", () => {
  test("a message its handler throws on fails as a violation and ends the process", async () => {
    const violations: string[] = [];
    const harness = startShell('echo \'{"kind":"bad"}\'; exec sleep 30', {
      message: () => {
        throw new RangeError("out of range");
      },
      violation: (message) => {
        violations.push(message);
      },
    });
    // Without the guard the reading stops and nothing ends the process.
    const exit = await settledWithin(harness.exited, {
      description: "the harness to end after a message it could not handle",
      timeoutMs: 10_000,
    });
    expect(exit).toEqual({ exitCode: null, signal: "SIGTERM" });
    expect(violations).toEqual([
      "Stella could not handle a message from the harness.",
    ]);
  });

  test("a request past its deadline says so, and the process ends", async () => {
    const harness = startShell("exec sleep 30");
    expect(harness.missedDeadline()).toBe(false);
    const answer = await harness.request(1, "initialize", { id: 1 }, 50);
    expect(Result.isError(answer)).toBe(true);
    expect(harness.missedDeadline()).toBe(true);
    expect(await harness.exited).toEqual({ exitCode: null, signal: "SIGTERM" });
  });
});

describe("a harness's stderr tail as text", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  test("UTF-8 reads as itself", () => {
    expect(decodeStderrTail(bytes("chyba: přihlášení vypršelo"))).toBe(
      "chyba: přihlášení vypršelo",
    );
  });

  test("a tail cut inside a character drops the character's remainder", () => {
    const whole = bytes("č quota exceeded");
    expect(decodeStderrTail(whole.subarray(1))).toBe(" quota exceeded");
  });

  test("bytes that are not UTF-8 read as question marks", () => {
    expect(decodeStderrTail(new Uint8Array([0x6f, 0x6b, 0xff, 0x21]))).toBe(
      "ok?!",
    );
  });
  test("only what was written from a mark on is read", () => {
    const tail = bytes("before|during");
    expect(stderrTailSince(tail, tail.length, "before|".length)).toBe("during");
  });

  test("a full tail still shows what was written after the mark", () => {
    // The tail kept the newest 13 bytes of 30 read; the mark was at 24.
    const tail = bytes("old_____newest");
    expect(stderrTailSince(tail.subarray(1), 30, 24)).toBe("newest");
  });

  test("a mark older than the tail reads the whole tail", () => {
    const tail = bytes("kept");
    expect(stderrTailSince(tail, 100, 10)).toBe("kept");
  });
});

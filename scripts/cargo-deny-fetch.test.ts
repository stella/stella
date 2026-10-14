import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const script = path.join(
  import.meta.dirname,
  "../.github/actions/cargo-deny/fetch.sh",
);

// Fake cargo: records each call and fails until the configured attempt.
const cargo = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FETCH_TEST_CALLS"
calls="$(wc -l < "$FETCH_TEST_CALLS")"
[[ "$calls" -ge "$FETCH_TEST_SUCCEED_ON" ]]
`;

const runFetch = (succeedOn: number) => {
  const directory = mkdtempSync(path.join(tmpdir(), "cargo-deny-fetch-"));
  const commands = path.join(directory, "commands");
  const calls = path.join(directory, "calls");
  try {
    mkdirSync(commands);
    writeFileSync(path.join(commands, "cargo"), cargo);
    chmodSync(path.join(commands, "cargo"), 0o755);
    writeFileSync(calls, "");
    const result = spawnSync("bash", [script, "app/Cargo.toml"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${commands}${path.delimiter}${process.env["PATH"] ?? ""}`,
        CARGO_DENY_FETCH_DELAY: "0",
        FETCH_TEST_CALLS: calls,
        FETCH_TEST_SUCCEED_ON: String(succeedOn),
      },
    });
    if (result.error) {
      throw result.error;
    }
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      calls: readFileSync(calls, "utf-8").trim().split("\n"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test("a transient fetch failure is retried until the download succeeds", () => {
  const result = runFetch(3);
  expect(result.status).toBe(0);
  expect(result.calls).toEqual(
    Array.from(
      { length: 3 },
      () => "deny --manifest-path app/Cargo.toml fetch db index",
    ),
  );
});

test("a fetch that keeps failing stops after the bounded attempts", () => {
  const result = runFetch(99);
  expect(result.status).toBe(1);
  expect(result.calls).toHaveLength(3);
  expect(result.output).toContain("after 3 attempts");
});

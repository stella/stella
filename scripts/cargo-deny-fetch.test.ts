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

// Fake cargo: records each call; the advisory fetch fails until the configured
// attempt, and the crate fetch fails when told to.
const cargo = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FETCH_TEST_CALLS"
if [[ "$1" == "fetch" ]]; then
  [[ "$FETCH_TEST_CRATES" == "ok" ]]
  exit
fi
attempts="$(grep -c "^deny" "$FETCH_TEST_CALLS")"
[[ "$attempts" -ge "$FETCH_TEST_SUCCEED_ON" ]]
`;

const CRATES = "fetch --locked --manifest-path app/Cargo.toml";
const ADVISORIES = "deny --manifest-path app/Cargo.toml fetch db index";

const runFetch = (
  succeedOn: number,
  crates: "ok" | "down" = "ok",
  sources: string[] = ["db", "index"],
) => {
  const directory = mkdtempSync(path.join(tmpdir(), "cargo-deny-fetch-"));
  const commands = path.join(directory, "commands");
  const calls = path.join(directory, "calls");
  try {
    mkdirSync(commands);
    writeFileSync(path.join(commands, "cargo"), cargo);
    chmodSync(path.join(commands, "cargo"), 0o755);
    writeFileSync(calls, "");
    const result = spawnSync("bash", [script, "app/Cargo.toml", ...sources], {
      maxBuffer: 2 ** 30,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${commands}${path.delimiter}${process.env["PATH"] ?? ""}`,
        CARGO_DENY_FETCH_DELAY: "0",
        FETCH_TEST_CALLS: calls,
        FETCH_TEST_SUCCEED_ON: String(succeedOn),
        FETCH_TEST_CRATES: crates,
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

test("dependency crates are fetched before the advisory database", () => {
  const result = runFetch(1);
  expect(result.status).toBe(0);
  expect(result.calls).toEqual([CRATES, ADVISORIES]);
});

test("without named sources only the dependency crates are fetched", () => {
  const result = runFetch(1, "ok", []);
  expect(result.status).toBe(0);
  expect(result.calls).toEqual([CRATES]);
});

test("a transient fetch failure is retried until the download succeeds", () => {
  const result = runFetch(3);
  expect(result.status).toBe(0);
  expect(result.calls).toEqual(
    Array.from({ length: 3 }, () => [CRATES, ADVISORIES]).flat(),
  );
  // The shared retry helper owns the attempt budget and its reporting.
  expect(result.output).toContain("retry.sh: attempt 1/3 failed");
  expect(result.output).toContain("succeeded on attempt 3/3");
});

test("a crate download that keeps failing stops after the bounded attempts", () => {
  const result = runFetch(1, "down");
  expect(result.status).toBe(1);
  expect(result.calls).toEqual([CRATES, CRATES, CRATES]);
  expect(result.output).toContain("after 3 attempts");
});

test("an advisory fetch that keeps failing stops after the bounded attempts", () => {
  const result = runFetch(99);
  expect(result.status).toBe(1);
  expect(result.calls.filter((call) => call === ADVISORIES)).toHaveLength(3);
  expect(result.output).toContain("after 3 attempts");
});

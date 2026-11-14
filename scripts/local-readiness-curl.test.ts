import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { repoRoot, trackedRepoFiles } from "./oxlint-config-scopes";

// A just-started container's published port accepts and then resets the
// connection until its server listens; --retry-connrefused does not retry that
// reset, so a readiness wait against a local port must retry every error.
const localTarget = /\b(127\.0\.0\.1|localhost)\b/u;

const curlCommands = (source: string) =>
  source
    .replaceAll(/\\\n/gu, " ")
    .split("\n")
    .filter((line) => /\bcurl\b/u.test(line) && /--retry\b/u.test(line));

test("retried curls against a local port retry every error", () => {
  const offenders: string[] = [];
  for (const file of trackedRepoFiles()) {
    if (
      !(file.startsWith(".github/") || file.startsWith("scripts/")) ||
      !/\.(sh|ya?ml)$/u.test(file)
    ) {
      continue;
    }
    const source = readFileSync(`${repoRoot}/${file}`, "utf-8");
    for (const command of curlCommands(source)) {
      if (
        localTarget.test(command) &&
        !command.includes("--retry-all-errors")
      ) {
        offenders.push(`${file}: ${command.trim()}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

test("the census sees a connection-refused-only readiness wait", () => {
  const unsafe =
    'curl --fail --retry 12 --retry-connrefused \\\n  "http://127.0.0.1:$port/"';
  const [command = ""] = curlCommands(unsafe);
  expect(localTarget.test(command)).toBe(true);
  expect(command.includes("--retry-all-errors")).toBe(false);
});

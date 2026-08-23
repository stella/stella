#!/usr/bin/env bun
// Keep lifecycle-script execution fail-closed. Declaring trustedDependencies
// disables Bun's evolving default list; this check proves that the lockfile's
// effective trusted set exactly matches the reviewed package.json allowlist.

import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

const packageJson: unknown = await Bun.file(
  path.join(REPO_ROOT, "package.json"),
).json();
if (typeof packageJson !== "object" || packageJson === null) {
  console.error("package.json did not parse into an object");
  process.exit(1);
}

const configured = Reflect.get(packageJson, "trustedDependencies");
if (
  !Array.isArray(configured) ||
  !configured.every((value) => typeof value === "string")
) {
  console.error("package.json trustedDependencies must be a string array");
  process.exit(1);
}

const expected = [...new Set(configured)].sort();
if (expected.length !== configured.length) {
  console.error("package.json trustedDependencies contains duplicate entries");
  process.exit(1);
}

const result = Bun.spawnSync(
  ["bun", "--no-env-file", "pm", "ls", "--trusted"],
  {
    cwd: REPO_ROOT,
    stderr: "pipe",
    stdout: "pipe",
  },
);
if (result.exitCode !== 0) {
  console.error(result.stderr.toString().trim());
  process.exit(result.exitCode);
}

const actual = result.stdout
  .toString()
  .split("\n")
  .flatMap((line) => {
    const match = /^[├└]── (.+)@[^@]+$/u.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  })
  .sort();

if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.error(
    [
      "trusted dependency allowlist does not match Bun's effective set:",
      `  configured: ${expected.join(", ") || "<none>"}`,
      `  effective:  ${actual.join(", ") || "<none>"}`,
    ].join("\n"),
  );
  process.exit(1);
}

console.log(`trusted dependency check: ${actual.join(", ")} (exact match).`);

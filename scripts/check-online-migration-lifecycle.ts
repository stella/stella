#!/usr/bin/env bun
// An online migration entry is `finalized` only once the promoted release
// carries it unchanged (see online-migration-lifecycle.ts). Reads the entry
// modules, the promoted release from the publication manifest, and that
// release's tag from git.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { lifecycleFindings } from "./online-migration-lifecycle";
import type { LifecycleEntry } from "./online-migration-lifecycle";
import { resolvePromotedRelease } from "./resolve-promoted-release";

const ENTRY_DIRECTORY = "apps/api/src/db/online-migration-entries";
const MANIFEST = "apps/landing/src/data/changelog-release-dates.json";
const EXEMPTIONS = "scripts/online-migration-lifecycle-exemptions.json";

const git = (args: string[]) =>
  Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });

const fail = (message: string): never => {
  process.stderr.write(`online migration lifecycle: ${message}\n`);
  process.exit(1);
};

const release = resolvePromotedRelease(
  JSON.parse(readFileSync(MANIFEST, "utf-8")),
).match({
  ok: (tag) => tag,
  err: (error) => fail(error.message),
});

const tagRef = `refs/tags/${release}`;
if (git(["rev-parse", "--verify", "--quiet", tagRef]).exitCode !== 0) {
  // A shallow or tagless checkout fetches just this tag, retrying a
  // transient network failure like every other CI fetch.
  const fetched = Bun.spawnSync(
    [
      "bash",
      "scripts/retry.sh",
      "git",
      "fetch",
      "--no-tags",
      "origin",
      `+${tagRef}:${tagRef}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (fetched.exitCode !== 0) {
    fail(`could not read ${release}: ${fetched.stderr.toString().trim()}`);
  }
}

const entries: LifecycleEntry[] = readdirSync(ENTRY_DIRECTORY)
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .toSorted()
  .map((file) => {
    const entryPath = path.posix.join(ENTRY_DIRECTORY, file);
    return { path: entryPath, text: readFileSync(entryPath, "utf-8") };
  });

const parsedExemptions: unknown = JSON.parse(readFileSync(EXEMPTIONS, "utf-8"));
const exemptionEntries: unknown =
  typeof parsedExemptions === "object" &&
  parsedExemptions !== null &&
  "entries" in parsedExemptions
    ? parsedExemptions.entries
    : undefined;
if (typeof exemptionEntries !== "object" || exemptionEntries === null) {
  fail(`${EXEMPTIONS} must hold an "entries" object`);
}
const exemptions: Record<string, string> = Object.fromEntries(
  Object.entries(exemptionEntries ?? {}).map(([entry, reason]) => [
    entry,
    typeof reason === "string" ? reason : "",
  ]),
);

const findings = lifecycleFindings({
  entries,
  release,
  exemptions,
  readAtRelease: (entryPath) => {
    const shown = git(["show", `${tagRef}:${entryPath}`]);
    return shown.exitCode === 0 ? shown.stdout.toString() : undefined;
  },
});
if (findings.length > 0) {
  fail(`\n  ${findings.join("\n  ")}`);
}
process.stdout.write(
  `online migration lifecycle: ${String(entries.length)} entries agree with ${release}\n`,
);

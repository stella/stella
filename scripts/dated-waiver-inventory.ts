/**
 * Prepares the dated exception check and lists the inventory. Everything that
 * reads git lives here: `dated-waivers.ts --check` runs under the offline
 * preload and only reads the files this script prepares.
 *
 * Run: `bun scripts/dated-waiver-inventory.ts --prepare --tracked-files <file>`
 * or `bun scripts/dated-waiver-inventory.ts [--json | --within <duration> | --due | --warn]`
 */

import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { quarantineBunfigFiles } from "./check-stll-quarantine-excludes";
import { trackedPolicyFiles } from "./dated-waiver-tracked-files";
import {
  type DatedWaiver,
  dueWaivers,
  exceptionInventory,
  loadWaivers,
  readTrackedPolicyFiles,
  type WaiverReference,
  waiverWarnings,
  withinHours,
} from "./dated-waivers";
import { readExpiryCheckScope } from "./expiry-check-scope-git";

const prepareCheck = (file: string): void => {
  const tracked = trackedPolicyFiles();
  writeFileSync(file, `${tracked.join("\0")}\0`);
  const scope = readExpiryCheckScope();
  const baseBunfigs = new Map<string, string>();
  const basePackageManifests = new Map<string, string>();
  const baseProposals = new Map<string, string>();
  let baseEntries: WaiverReference[] | null = null;
  if (scope.type === "changes") {
    if (!scope.baseSha) {
      panic("Expiry scope base is required");
    }
    const files = Bun.spawnSync([
      "git",
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      scope.baseSha,
    ]);
    if (files.exitCode !== 0) {
      panic("Cannot enumerate expiry base files");
    }
    const baseFiles = files.stdout.toString().split("\0").filter(Boolean);
    for (const source of baseFiles.filter(
      (candidate) =>
        quarantineBunfigFiles([candidate]).length > 0 ||
        candidate.startsWith(".github/dated-exception-proposals/") ||
        (scope.changedFiles.has(candidate) &&
          (candidate === "package.json" ||
            candidate.endsWith("/package.json"))),
    )) {
      const contents = Bun.spawnSync([
        "git",
        "show",
        `${scope.baseSha}:${source}`,
      ]);
      if (contents.exitCode !== 0) {
        panic(`Cannot read expiry base owner ${source}`);
      }
      if (source.endsWith("bunfig.toml")) {
        baseBunfigs.set(source, contents.stdout.toString());
      } else if (source.startsWith(".github/dated-exception-proposals/")) {
        baseProposals.set(source, contents.stdout.toString());
      } else {
        basePackageManifests.set(source, contents.stdout.toString());
      }
    }
    // A new or renewed proposal's reference is checked against the base
    // inventory, so its recorded deadline cannot be chosen by the proposal.
    if (
      tracked.some(
        (candidate) =>
          candidate.startsWith(".github/dated-exception-proposals/") &&
          (!baseProposals.has(candidate) ||
            baseProposals.get(candidate) !==
              readFileSync(
                path.join(import.meta.dir, "..", candidate),
                "utf-8",
              )),
      )
    ) {
      baseEntries = baseWaiverReferences(scope.baseSha, baseFiles);
    }
  }
  writeFileSync(
    `${file}.context.json`,
    JSON.stringify({
      scope:
        scope.type === "all"
          ? scope
          : { ...scope, changedFiles: [...scope.changedFiles] },
      baseBunfigs: Object.fromEntries(baseBunfigs),
      basePackageManifests: Object.fromEntries(basePackageManifests),
      baseProposals: Object.fromEntries(baseProposals),
      baseEntries,
    }),
  );
};

// Reads many files of one commit with a single `git cat-file --batch`.
const readCommitFiles = (
  sha: string,
  files: readonly string[],
): Map<string, string> => {
  const batch = Bun.spawnSync(["git", "cat-file", "--batch"], {
    stdin: Buffer.from(files.map((file) => `${sha}:${file}\n`).join("")),
  });
  if (batch.exitCode !== 0) {
    panic("Cannot read expiry base owners");
  }
  const output = batch.stdout;
  const contents = new Map<string, string>();
  let offset = 0;
  for (const file of files) {
    const headerEnd = output.indexOf(10, offset);
    const header = output.subarray(offset, headerEnd).toString();
    const size = Number(/^[0-9a-f]+ blob (\d+)$/u.exec(header)?.at(1));
    if (headerEnd === -1 || !Number.isSafeInteger(size)) {
      panic(`Cannot read expiry base owner ${file}`);
    }
    const start = headerEnd + 1;
    contents.set(file, output.subarray(start, start + size).toString());
    offset = start + size + 1;
  }
  return contents;
};

/**
 * The inventory of a base commit. Which files the inventory reads is known
 * only while it runs, so each round records the files it was missing and the
 * next round reads them all at once.
 */
export const baseWaiverReferences = (
  baseSha: string,
  baseFiles: readonly string[],
): WaiverReference[] => {
  // Only test files carrying the quarantine marker can contribute entries.
  const marked = Bun.spawnSync([
    "git",
    "grep",
    "-l",
    "-z",
    "test-quarantine-expires:",
    baseSha,
  ]);
  if (marked.exitCode !== 0 && marked.exitCode !== 1) {
    panic("Cannot search expiry base quarantines");
  }
  const quarantined = new Set(
    marked.stdout
      .toString()
      .split("\0")
      .filter(Boolean)
      .map((match) => match.slice(baseSha.length + 1)),
  );
  const files = baseFiles.filter(
    (file) =>
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file) || quarantined.has(file),
  );
  const contents = new Map<string, string>();
  for (let round = 0; round < 8; round += 1) {
    const missing = new Set<string>();
    const read = (file: string): string => {
      const text = contents.get(file);
      if (text === undefined) {
        missing.add(file);
        return "";
      }
      return text;
    };
    let entries: DatedWaiver[] | undefined;
    try {
      entries = loadWaivers(files, read);
    } catch (error) {
      // A placeholder for an unread file can fail parsing; only an error in
      // a round that read every file it needed is real.
      if (missing.size === 0) {
        throw error;
      }
    }
    if (missing.size === 0 && entries) {
      return entries.map(({ kind, source, id, expiresAt }) => ({
        kind,
        source,
        id,
        expiresAt,
      }));
    }
    for (const [file, text] of readCommitFiles(baseSha, [...missing])) {
      contents.set(file, text);
    }
  }
  return panic("Expiry base inventory did not settle");
};

if (import.meta.main) {
  const trackedFilesFlag = process.argv.indexOf("--tracked-files");
  const trackedFilesPath =
    trackedFilesFlag === -1 ? undefined : process.argv.at(trackedFilesFlag + 1);
  if (trackedFilesFlag !== -1 && !trackedFilesPath) {
    panic("--tracked-files requires a path");
  }
  if (process.argv.includes("--prepare")) {
    if (trackedFilesPath === undefined) {
      panic("--prepare requires --tracked-files");
    }
    prepareCheck(trackedFilesPath);
    process.exit(0);
  }
  const entries = loadWaivers(
    trackedFilesPath === undefined
      ? trackedPolicyFiles()
      : readTrackedPolicyFiles(trackedFilesPath),
  );
  if (process.argv.includes("--json") || process.argv.includes("--within")) {
    const index = process.argv.indexOf("--within");
    const value = process.argv.at(index + 1);
    const now = new Date();
    if (index !== -1 && value === undefined) {
      panic("--within requires a duration");
    }
    const selected =
      index === -1
        ? entries
        : dueWaivers(entries, now, withinHours(value ?? "") / 24);
    console.log(JSON.stringify(exceptionInventory(selected, now), null, 2));
  } else if (process.argv.includes("--due")) {
    console.log(dueWaivers(entries, new Date()).length > 0);
  } else if (process.argv.includes("--warn")) {
    for (const warning of waiverWarnings(entries, new Date())) {
      console.log(warning);
    }
  } else {
    console.log(JSON.stringify(entries, null, 2));
  }
}

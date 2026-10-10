#!/usr/bin/env bun

// Freshness combines recording provenance with the canonical rendered
// screenshot comparison. Metadata-only callers use marketing:provenance;
// metadata alone never certifies rendered output as fresh.

import { panic } from "better-result";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import nodePath from "node:path";

import { compareCodeUnit } from "@stll/collation";
import { createSha256 } from "@stll/sha256/bun";

import {
  CAPTURE_THEMES,
  captureDefinitions,
  RECORDINGS_MANIFEST_PATH,
} from "../apps/web/e2e/marketing/captures";
import type {
  CaptureTheme,
  CaptureViewport,
  RecordingManifestEntry,
} from "../apps/web/e2e/marketing/captures";
import {
  readProductMediaManifestSync,
  updateRecordingArtifactDigest,
  recordingArtifactPaths,
  recordingArtifactsHashFromManifest,
} from "./product-media";

const ROOT_DIR = nodePath.resolve(import.meta.dirname, "..");
const STRICT = process.argv.includes("--strict");
const PROVENANCE_ONLY = process.argv.includes("--provenance-only");

export type ManualRecordingVerification = {
  artifactsHash: string;
  reason: string;
  watchedPathsHash: string;
};

export type RecordingManifestEntryWithVerification = RecordingManifestEntry & {
  manualVerification?: ManualRecordingVerification;
};

export type Verdict = {
  basis: "manual-verification" | "recording" | null;
  captureId: string;
  theme: CaptureTheme;
  status: "FRESH" | "STALE";
  reasons: readonly string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isViewport = (value: unknown): value is CaptureViewport =>
  isRecord(value) &&
  typeof value["width"] === "number" &&
  typeof value["height"] === "number";

const isTheme = (value: unknown): value is CaptureTheme =>
  CAPTURE_THEMES.some((theme) => theme === value);

const SHA_256_PATTERN = /^[0-9a-f]{64}$/u;

const isManualVerification = (
  value: unknown,
): value is ManualRecordingVerification =>
  isRecord(value) &&
  typeof value["reason"] === "string" &&
  value["reason"].trim() === value["reason"] &&
  value["reason"].length >= 12 &&
  value["reason"].length <= 240 &&
  typeof value["artifactsHash"] === "string" &&
  SHA_256_PATTERN.test(value["artifactsHash"]) &&
  typeof value["watchedPathsHash"] === "string" &&
  SHA_256_PATTERN.test(value["watchedPathsHash"]);

const isManifestEntry = (
  value: unknown,
): value is RecordingManifestEntryWithVerification =>
  isRecord(value) &&
  typeof value["captureId"] === "string" &&
  isTheme(value["theme"]) &&
  isViewport(value["viewport"]) &&
  typeof value["dpr"] === "number" &&
  typeof value["recordedAtCommit"] === "string" &&
  Array.isArray(value["watchedPaths"]) &&
  value["watchedPaths"].every((path) => typeof path === "string") &&
  (value["manualVerification"] === undefined ||
    isManualVerification(value["manualVerification"]));

export const readManifestEntries =
  (): RecordingManifestEntryWithVerification[] => {
    const manifestPath = nodePath.join(ROOT_DIR, RECORDINGS_MANIFEST_PATH);
    if (!existsSync(manifestPath)) {
      return [];
    }
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (!isRecord(parsed) || !Array.isArray(parsed["entries"])) {
      panic(`${RECORDINGS_MANIFEST_PATH} must contain an entries array`);
    }
    return parsed["entries"].map((entry, index) => {
      if (!isManifestEntry(entry)) {
        panic(`${RECORDINGS_MANIFEST_PATH} entry ${index} is malformed`);
      }
      return entry;
    });
  };

const git = (args: readonly string[]): string =>
  execFileSync("git", [...args], { cwd: ROOT_DIR, encoding: "utf-8" }).trim();

export const watchedPathsHashAtHead = (
  watchedPaths: readonly string[],
): string => {
  const normalizedPaths = [...new Set(watchedPaths)].toSorted();
  const tree = git([
    "ls-tree",
    "-r",
    "--full-tree",
    "HEAD",
    "--",
    ...normalizedPaths,
  ]);
  return createSha256()
    .update(`${JSON.stringify(normalizedPaths)}\n${tree}\n`)
    .digest("hex");
};

export const recordingArtifactsHash = (
  captureId: string,
  theme: CaptureTheme,
): string => {
  const paths = recordingArtifactPaths(captureId, theme).map(
    (path) => `apps/landing/public/${path}`,
  );
  if (paths.every((path) => !existsSync(nodePath.join(ROOT_DIR, path)))) {
    const manifestHash = recordingArtifactsHashFromManifest(
      readProductMediaManifestSync(),
      captureId,
      theme,
    );
    if (manifestHash !== undefined) {
      return manifestHash;
    }
  }
  const hasher = createSha256();
  for (const path of paths) {
    updateRecordingArtifactDigest({
      hasher,
      path,
      bytes: readFileSync(nodePath.join(ROOT_DIR, path)),
    });
  }
  return hasher.digest("hex");
};

type ManualVerificationMatchOptions = {
  captureId: string;
  theme: CaptureTheme;
  verification: ManualRecordingVerification | undefined;
  watchedPaths: readonly string[];
};

export const manualVerificationMatches = ({
  captureId,
  theme,
  verification,
  watchedPaths,
}: ManualVerificationMatchOptions): boolean => {
  if (!verification) {
    return false;
  }
  let artifactsHash: string;
  try {
    artifactsHash = recordingArtifactsHash(captureId, theme);
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") {
      return false;
    }
    throw error;
  }
  return (
    verification.watchedPathsHash === watchedPathsHashAtHead(watchedPaths) &&
    verification.artifactsHash === artifactsHash
  );
};

const isKnownCommit = (commit: string): boolean => {
  try {
    git(["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};

// Committed history only: releases run on committed trees, and diffing against
// the working tree would flag the in-flight commit that updates the manifest
// itself.
const changedWatchedPaths = (
  recordedAtCommit: string,
  watchedPaths: readonly string[],
): string[] => {
  const output = git([
    "diff",
    "--name-only",
    recordedAtCommit,
    "HEAD",
    "--",
    ...watchedPaths,
  ]);
  return output === "" ? [] : output.split("\n");
};

export const rerecordCommand = (
  captureIds: readonly string[],
  theme?: CaptureTheme,
) =>
  [
    "cd apps/web &&",
    `MARKETING_CAPTURE=${[...new Set(captureIds)].join(",")}`,
    ...(theme ? [`MARKETING_THEME=${theme}`] : []),
    "bun run capture:product-story",
  ].join(" ");

export const judgeEntry = (
  entry: RecordingManifestEntryWithVerification,
): Verdict => {
  const reasons: string[] = [];
  let basis: Verdict["basis"] = null;
  const definition = captureDefinitions.find(
    ({ captureId }) => captureId === entry.captureId,
  );
  if (!definition) {
    reasons.push("capture id is no longer in the capture matrix (captures.ts)");
  } else {
    if (
      definition.viewport.width !== entry.viewport.width ||
      definition.viewport.height !== entry.viewport.height
    ) {
      reasons.push(
        `viewport drifted: recorded ${entry.viewport.width}x${entry.viewport.height}, ` +
          `expected ${definition.viewport.width}x${definition.viewport.height}`,
      );
    }
    if (definition.dpr !== entry.dpr) {
      reasons.push(
        `device pixel ratio drifted: recorded ${entry.dpr}x, expected ${definition.dpr}x`,
      );
    }
  }

  // Manual verification is bound directly to the current watched tree and media,
  // so it remains valid when the original recording commit is no longer reachable.
  const watchedPaths = definition?.watchedPaths ?? entry.watchedPaths;
  if (
    manualVerificationMatches({
      captureId: entry.captureId,
      theme: entry.theme,
      verification: entry.manualVerification,
      watchedPaths,
    })
  ) {
    basis = "manual-verification";
  } else if (entry.manualVerification) {
    reasons.push(
      "manual verification does not match the watched source tree or recording artifacts",
    );
  } else if (!isKnownCommit(entry.recordedAtCommit)) {
    reasons.push(
      `recorded-at commit ${entry.recordedAtCommit} is unknown here`,
    );
  } else {
    // The current matrix wins over the snapshot the entry was stamped with:
    // a watched path added to captures.ts after a recording must invalidate
    // that recording too, which a stored snapshot could never do.
    const changedPaths = changedWatchedPaths(
      entry.recordedAtCommit,
      watchedPaths,
    );
    if (changedPaths.length === 0) {
      basis = "recording";
    } else {
      reasons.push(...changedPaths.map((path) => `changed: ${path}`));
    }
  }

  return {
    basis: reasons.length === 0 ? basis : null,
    captureId: entry.captureId,
    theme: entry.theme,
    status: reasons.length === 0 ? "FRESH" : "STALE",
    reasons,
  };
};

// Shared with scripts/marketing-reshoot.ts so the reshoot script's stale set
// shares the provenance classifier rather than duplicating source checks.
// Rendered freshness is verified separately before reporting FRESH.
export const computeProvenanceVerdicts = (): Verdict[] => {
  const entries = readManifestEntries();
  const entryKeys = new Set(
    entries.map((entry) => `${entry.captureId}:${entry.theme}`),
  );

  const verdicts = entries.map(judgeEntry);
  // Captures the matrix expects but the manifest has never seen are stale by
  // definition: there is no provenance to check.
  for (const definition of captureDefinitions) {
    for (const theme of CAPTURE_THEMES) {
      if (entryKeys.has(`${definition.captureId}:${theme}`)) {
        continue;
      }
      verdicts.push({
        basis: null,
        captureId: definition.captureId,
        theme,
        status: "STALE",
        reasons: ["never recorded into the manifest"],
      });
    }
  }

  verdicts.sort(
    (a, b) =>
      compareCodeUnit(a.captureId, b.captureId) ||
      compareCodeUnit(a.theme, b.theme),
  );
  return verdicts;
};

export const compareRenderedScreenshots = (
  run = (command: readonly string[]) =>
    Bun.spawnSync([...command], {
      cwd: ROOT_DIR,
      stdout: "inherit",
      stderr: "inherit",
    }).success,
) => run(["bun", "--filter", "@stll/web", "test:e2e:marketing"]);

export const computeVerdicts = (
  verdicts: readonly Verdict[] = computeProvenanceVerdicts(),
  compare = compareRenderedScreenshots,
): Verdict[] => {
  if (!verdicts.some(({ status }) => status === "FRESH") || compare()) {
    return [...verdicts];
  }
  return verdicts.map((verdict) =>
    verdict.status === "STALE"
      ? verdict
      : {
          ...verdict,
          basis: null,
          status: "STALE",
          reasons: [
            "rendered screenshot comparison did not pass; source metadata cannot certify freshness",
          ],
        },
  );
};

const main = () => {
  const verdicts = PROVENANCE_ONLY
    ? computeProvenanceVerdicts()
    : computeVerdicts();
  const stale = verdicts.filter(({ status }) => status === "STALE");
  for (const verdict of verdicts) {
    const label = `${verdict.captureId} (${verdict.theme})`;
    if (verdict.status === "FRESH") {
      const suffix =
        verdict.basis === "manual-verification" ? " (manual verification)" : "";
      process.stdout.write(
        `${PROVENANCE_ONLY ? "PROVENANCE_MATCH" : "FRESH"} ${label}${suffix}\n`,
      );
      continue;
    }
    process.stdout.write(
      `${PROVENANCE_ONLY ? "PROVENANCE_CHANGED" : "STALE"} ${label}\n`,
    );
    for (const reason of verdict.reasons) {
      process.stdout.write(`      ${reason}\n`);
    }
    process.stdout.write(
      `      re-record: ${rerecordCommand([verdict.captureId], verdict.theme)}\n`,
    );
  }

  if (stale.length === 0) {
    process.stdout.write(
      `marketing-recordings: all ${verdicts.length} recordings ${PROVENANCE_ONLY ? "have matching source metadata (rendered output not checked)" : "are fresh"}\n`,
    );
    return;
  }

  process.stdout.write(
    `marketing-recordings: ${stale.length}/${verdicts.length} recordings ${PROVENANCE_ONLY ? "have changed source metadata" : "are stale"}\n`,
  );
  process.stdout.write(
    `re-record all stale (both themes): ${rerecordCommand(stale.map(({ captureId }) => captureId))}\n`,
  );
  if (STRICT) {
    process.exit(1);
  }
};

// Guarded so scripts/marketing-reshoot.ts can import `computeVerdicts` (and
// the other exports above) without triggering this script's own CLI output
// or --strict exit code as a module-level side effect.
if (import.meta.main) {
  main();
}

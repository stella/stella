#!/usr/bin/env bun

// Explicit release escape hatch for recordings that were visually reviewed
// against the current product but do not need to be re-recorded. The
// attestation binds that review to the exact watched source tree, so the next
// relevant code change makes it stale automatically.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import nodePath from "node:path";

import {
  captureDefinitions,
  RECORDINGS_MANIFEST_PATH,
} from "../apps/web/e2e/marketing/captures";
import {
  computeVerdicts,
  readManifestEntries,
  watchedPathsHashAtHead,
} from "./check-marketing-recordings";

const ROOT_DIR = nodePath.resolve(import.meta.dirname, "..");
const CONFIRMATION_FLAG = "--confirm-current-recordings-reviewed";
const REASON_FLAG = "--reason";
const CAPTURE_FLAG = "--capture";

type VerificationOptions = {
  captureIds: ReadonlySet<string> | null;
  reason: string;
};

class MarketingVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketingVerificationError";
  }
}

const optionValue = (args: readonly string[], flag: string) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args.at(index + 1);
};

export const parseVerificationOptions = (
  args: readonly string[],
): VerificationOptions => {
  if (!args.includes(CONFIRMATION_FLAG)) {
    throw new MarketingVerificationError(
      `Pass ${CONFIRMATION_FLAG} after visually reviewing every selected recording`,
    );
  }
  const reason = optionValue(args, REASON_FLAG);
  if (
    !reason ||
    reason.trim() !== reason ||
    reason.length < 12 ||
    reason.length > 240
  ) {
    throw new MarketingVerificationError(
      `${REASON_FLAG} must be a trimmed reason between 12 and 240 characters`,
    );
  }
  const captureValue = optionValue(args, CAPTURE_FLAG);
  const captureIds = captureValue
    ? new Set(captureValue.split(",").filter(Boolean))
    : null;
  if (captureValue !== undefined && captureIds?.size === 0) {
    throw new MarketingVerificationError(
      `${CAPTURE_FLAG} must name at least one capture`,
    );
  }
  const knownCaptureIds = new Set(
    captureDefinitions.map(({ captureId }) => captureId),
  );
  const unknownCaptureIds = [...(captureIds ?? [])].filter(
    (captureId) => !knownCaptureIds.has(captureId),
  );
  if (unknownCaptureIds.length > 0) {
    throw new MarketingVerificationError(
      `Unknown capture id(s): ${unknownCaptureIds.join(", ")}`,
    );
  }
  return { captureIds, reason };
};

const assertWatchedPathsClean = (watchedPaths: readonly string[]) => {
  const result = Bun.spawnSync([
    "git",
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ...watchedPaths,
  ], {
    cwd: ROOT_DIR,
    stdout: "pipe",
  });
  if (!result.success || result.stdout.length > 0) {
    throw new MarketingVerificationError(
      "Commit watched-path changes before creating a manual verification",
    );
  }
};

const main = () => {
  const options = parseVerificationOptions(process.argv.slice(2));
  const staleKeys = new Set(
    computeVerdicts()
      .filter(
        ({ captureId, status }) =>
          status === "STALE" && (options.captureIds?.has(captureId) ?? true),
      )
      .map(({ captureId, theme }) => `${captureId}:${theme}`),
  );
  if (staleKeys.size === 0) {
    process.stdout.write(
      "marketing-verification: no selected stale recordings\n",
    );
    return;
  }

  const definitionsById = new Map(
    captureDefinitions.map((definition) => [definition.captureId, definition]),
  );
  const watchedPaths = [
    ...new Set(
      [...staleKeys].flatMap((key) => {
        const captureId = key.slice(0, key.lastIndexOf(":"));
        return definitionsById.get(captureId)?.watchedPaths ?? [];
      }),
    ),
  ];
  assertWatchedPathsClean(watchedPaths);

  const entries = readManifestEntries().map((entry) => {
    if (!staleKeys.has(`${entry.captureId}:${entry.theme}`)) {
      return entry;
    }
    const definition = definitionsById.get(entry.captureId);
    if (!definition) {
      throw new MarketingVerificationError(
        `Missing capture definition for ${entry.captureId}`,
      );
    }
    return {
      ...entry,
      manualVerification: {
        reason: options.reason,
        watchedPathsHash: watchedPathsHashAtHead(definition.watchedPaths),
      },
    };
  });

  writeFileSync(
    nodePath.join(ROOT_DIR, RECORDINGS_MANIFEST_PATH),
    `${JSON.stringify({ entries }, null, 2)}\n`,
  );
  const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: ROOT_DIR,
    encoding: "utf-8",
  }).trim();
  process.stdout.write(
    `marketing-verification: attested ${String(staleKeys.size)} recording(s) against ${head}\n`,
  );
};

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`marketing-verification: ${message}`);
    process.exit(1);
  }
}

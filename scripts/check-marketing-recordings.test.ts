import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";

import { captureDefinitions } from "../apps/web/e2e/marketing/captures";
import {
  judgeEntry,
  manualVerificationMatches,
  uncoveredChangedPaths,
  watchedPathsHashAtHead,
} from "./check-marketing-recordings";
import { parseVerificationOptions } from "./verify-marketing-recordings";

const definition =
  captureDefinitions.at(0) ?? panic("expected a marketing capture definition");

describe("marketing recording freshness", () => {
  test("binds manual verification to the exact watched source tree", () => {
    const watchedPathsHash = watchedPathsHashAtHead(definition.watchedPaths);

    expect(
      manualVerificationMatches(
        { reason: "Reviewed for a maintenance release", watchedPathsHash },
        [...definition.watchedPaths].reverse(),
      ),
    ).toBe(true);
    expect(
      manualVerificationMatches(
        {
          reason: "Reviewed for a maintenance release",
          watchedPathsHash: "0".repeat(64),
        },
        definition.watchedPaths,
      ),
    ).toBe(false);
  });

  test("accepts a matching explicit verification as the freshness basis", () => {
    const recordedAtCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf-8",
    }).trim();
    const verdict = judgeEntry({
      captureId: definition.captureId,
      dpr: definition.dpr,
      manualVerification: {
        reason: "Reviewed for a maintenance release",
        watchedPathsHash: watchedPathsHashAtHead(definition.watchedPaths),
      },
      recordedAtCommit,
      theme: "light",
      viewport: definition.viewport,
      watchedPaths: definition.watchedPaths,
    });

    expect(verdict).toMatchObject({
      basis: "manual-verification",
      reasons: [],
      status: "FRESH",
    });
  });

  test("uses a current visual reference only for source changes it covers", () => {
    const recorderPath = "apps/web/e2e/marketing/record-product-story.ts";
    const sourcePath = "apps/web/src/components/breadcrumbs/index.tsx";

    expect(uncoveredChangedPaths([sourcePath], true)).toEqual([]);
    expect(uncoveredChangedPaths([sourcePath], false)).toEqual([sourcePath]);
    expect(uncoveredChangedPaths([sourcePath, recorderPath], true)).toEqual([
      recorderPath,
    ]);
  });

  test("requires deliberate confirmation and a review reason", () => {
    expect(() => parseVerificationOptions([])).toThrow(
      "--confirm-current-recordings-reviewed",
    );
    expect(() =>
      parseVerificationOptions([
        "--confirm-current-recordings-reviewed",
        "--reason",
        "Reviewed for a maintenance release",
      ]),
    ).not.toThrow();
  });
});

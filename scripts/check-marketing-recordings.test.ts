import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";

import { captureDefinitions } from "../apps/web/e2e/marketing/captures";
import {
  judgeEntry,
  manualVerificationMatches,
  watchedPathsHashAtHead,
} from "./check-marketing-recordings";
import {
  parseVerificationOptions,
  partitionAttestableKeys,
} from "./verify-marketing-recordings";

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

  test("does not let source verification hide capture-contract drift", () => {
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
      viewport: {
        height: definition.viewport.height + 1,
        width: definition.viewport.width,
      },
      watchedPaths: definition.watchedPaths,
    });

    expect(verdict.status).toBe("STALE");
    expect(verdict.reasons.at(0)).toStartWith("viewport drifted");
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
    expect(() =>
      parseVerificationOptions([
        "--confirm-current-recordings-reviewed",
        "--reason",
        "Reviewed for a maintenance release",
        "--capture",
      ]),
    ).toThrow("--capture requires a value");
    expect(() =>
      parseVerificationOptions([
        "--confirm-current-recordings-reviewed",
        "--reason",
        "Reviewed for a maintenance release",
        "--captur",
        "workspace",
      ]),
    ).toThrow("Unknown argument: --captur");
  });

  test("never claims to attest a recording missing from the manifest", () => {
    const partition = partitionAttestableKeys(
      new Set(["workspace:light", "missing:dark"]),
      new Set(["workspace:light"]),
    );

    expect([...partition.attestableKeys]).toEqual(["workspace:light"]);
    expect(partition.neverRecorded).toEqual(["missing:dark"]);
  });
});

import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { captureDefinitions } from "../apps/web/e2e/marketing/captures";
import {
  computeVerdicts,
  compareRenderedScreenshots,
  type Verdict,
  judgeEntry,
  manualVerificationMatches,
  recordingArtifactsHash,
  watchedPathsHashAtHead,
} from "./check-marketing-recordings";
import {
  parseVerificationOptions,
  partitionAttestableKeys,
} from "./verify-marketing-recordings";

const definition =
  captureDefinitions.at(0) ?? panic("expected a marketing capture definition");

describe("marketing recording freshness", () => {
  test("binds manual verification to the exact reviewed source and media", () => {
    const watchedPathsHash = watchedPathsHashAtHead(definition.watchedPaths);

    expect(
      manualVerificationMatches({
        captureId: definition.captureId,
        theme: "light",
        verification: {
          artifactsHash: recordingArtifactsHash(definition.captureId, "light"),
          reason: "Reviewed for a maintenance release",
          watchedPathsHash,
        },
        watchedPaths: [...definition.watchedPaths].toReversed(),
      }),
    ).toBe(true);
    expect(
      manualVerificationMatches({
        captureId: definition.captureId,
        theme: "light",
        verification: {
          artifactsHash: recordingArtifactsHash(definition.captureId, "light"),
          reason: "Reviewed for a maintenance release",
          watchedPathsHash: "0".repeat(64),
        },
        watchedPaths: definition.watchedPaths,
      }),
    ).toBe(false);
    expect(
      manualVerificationMatches({
        captureId: definition.captureId,
        theme: "light",
        verification: {
          artifactsHash: "0".repeat(64),
          reason: "Reviewed for a maintenance release",
          watchedPathsHash,
        },
        watchedPaths: definition.watchedPaths,
      }),
    ).toBe(false);
    expect(
      manualVerificationMatches({
        captureId: "missing-artifact-fixture",
        theme: "light",
        verification: {
          artifactsHash: "0".repeat(64),
          reason: "Reviewed for a maintenance release",
          watchedPathsHash,
        },
        watchedPaths: definition.watchedPaths,
      }),
    ).toBe(false);
  });

  test("accepts matching explicit verification when the recording commit is unavailable", () => {
    const verdict = judgeEntry({
      captureId: definition.captureId,
      dpr: definition.dpr,
      manualVerification: {
        artifactsHash: recordingArtifactsHash(definition.captureId, "light"),
        reason: "Reviewed for a maintenance release",
        watchedPathsHash: watchedPathsHashAtHead(definition.watchedPaths),
      },
      recordedAtCommit: "0".repeat(40),
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
        artifactsHash: recordingArtifactsHash(definition.captureId, "light"),
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

  test("does not fall back to the recording stamp after media drift", () => {
    const recordedAtCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf-8",
    }).trim();
    const verdict = judgeEntry({
      captureId: definition.captureId,
      dpr: definition.dpr,
      manualVerification: {
        artifactsHash: "0".repeat(64),
        reason: "Reviewed for a maintenance release",
        watchedPathsHash: watchedPathsHashAtHead(definition.watchedPaths),
      },
      recordedAtCommit,
      theme: "light",
      viewport: definition.viewport,
      watchedPaths: definition.watchedPaths,
    });

    expect(verdict).toMatchObject({
      basis: null,
      reasons: [
        "manual verification does not match the watched source tree or recording artifacts",
      ],
      status: "STALE",
    });
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

describe("rendered marketing freshness", () => {
  test("matching source hashes or manual verification cannot hide a failed rendered comparison", () => {
    for (const basis of ["recording", "manual-verification"] as const) {
      const source = {
        basis,
        captureId: "agent",
        theme: "light",
        status: "FRESH",
        reasons: [],
      } as const satisfies Verdict;
      let comparisons = 0;
      const verdicts = computeVerdicts([source], () => {
        comparisons += 1;
        return false;
      });
      expect(comparisons).toBe(1);
      expect(verdicts).toEqual([
        {
          ...source,
          basis: null,
          status: "STALE",
          reasons: [
            "rendered screenshot comparison did not pass; source metadata cannot certify freshness",
          ],
        },
      ]);
      expect(computeVerdicts([source], () => true)).toEqual([source]);
    }
  });

  test("rendered freshness delegates to the same screenshot command as CI without changing its threshold", () => {
    const action = readFileSync(
      new URL(
        "../.github/actions/marketing-capture/action.yml",
        import.meta.url,
      ),
      "utf-8",
    );
    let comparisons = 0;
    const result = compareRenderedScreenshots((command) => {
      comparisons += 1;
      expect(command).toEqual([
        "bun",
        "--filter",
        "@stll/web",
        "test:e2e:marketing",
      ]);
      expect(action).toContain(command.join(" "));
      expect(command).not.toContain("--update-snapshots");
      return false;
    });
    expect(comparisons).toBe(1);
    expect(result).toBe(false);
  });
});

test("rendered checking skips already-stale entries and preserves their reasons in a mixed result", () => {
  const stale = {
    basis: null,
    captureId: "agent",
    theme: "light",
    status: "STALE",
    reasons: ["source changed"],
  } as const satisfies Verdict;
  const fresh = {
    ...stale,
    basis: "recording",
    status: "FRESH",
    reasons: [],
  } as const satisfies Verdict;
  expect(
    computeVerdicts([stale], () =>
      panic("Already-stale media must not render"),
    ),
  ).toEqual([stale]);
  const mixed = computeVerdicts([stale, fresh], () => false);
  expect(mixed.at(0)).toBe(stale);
  expect(mixed.at(1)?.status).toBe("STALE");
});

test("provenance-only reporting and reshoot dry-run never spawn rendered comparison", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "marketing-source-only-"));
  try {
    writeFileSync(
      path.join(directory, "bun"),
      "#!/usr/bin/env bash\necho RENDERED_COMPARISON_IN_SOURCE_ONLY >&2\nexit 91\n",
      { mode: 0o755 },
    );
    for (const { script, flag, output } of [
      {
        script: "check-marketing-recordings.ts",
        flag: "--provenance-only",
        output: /PROVENANCE_(?:MATCH|CHANGED)/u,
      },
      {
        script: "marketing-reshoot.ts",
        flag: "--dry-run",
        output: /--dry-run/u,
      },
    ]) {
      const result = Bun.spawnSync(
        [process.execPath, new URL(script, import.meta.url).pathname, flag],
        {
          env: {
            ...process.env,
            PATH: `${directory}:${process.env["PATH"] ?? ""}`,
          },
          timeout: 10_000,
        },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stderr.toString()).not.toContain(
        "RENDERED_COMPARISON_IN_SOURCE_ONLY",
      );
      expect(result.stdout.toString()).toMatch(output);
      expect(result.stdout.toString()).not.toMatch(/\bFRESH\b/u);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("maintenance release classification never invokes rendered comparison", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "maintenance-provenance-"));
  try {
    writeFileSync(
      path.join(directory, "bun"),
      "#!/usr/bin/env bash\necho RENDERED_COMPARISON_IN_MAINTENANCE >&2\nexit 91\n",
      { mode: 0o755 },
    );
    const modulePath = new URL(
      "prepare-maintenance-release.ts",
      import.meta.url,
    ).pathname;
    const result = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `import { staleCaptureIds } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(staleCaptureIds()));`,
      ],
      {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env["PATH"] ?? ""}`,
        },
        timeout: 10_000,
      },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stderr.toString()).not.toContain(
      "RENDERED_COMPARISON_IN_MAINTENANCE",
    );
    expect(Array.isArray(JSON.parse(result.stdout.toString()))).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("maintenance automation cannot select the rendered CLI boundary", () => {
  const source = readFileSync(
    new URL("prepare-maintenance-release.ts", import.meta.url),
    "utf-8",
  );
  const isProvenanceOnly = (candidate: string) =>
    candidate.includes('"marketing:provenance", "--strict"') &&
    !candidate.includes('"marketing:stale"') &&
    !/\b(?:computeVerdicts|compareRenderedScreenshots)\b/u.test(candidate);
  expect(isProvenanceOnly(source)).toBe(true);
  expect(
    isProvenanceOnly(
      source.replaceAll("computeProvenanceVerdicts", "computeVerdicts"),
    ),
  ).toBe(false);
  expect(
    isProvenanceOnly(
      source.replaceAll("marketing:provenance", "marketing:stale"),
    ),
  ).toBe(false);
});

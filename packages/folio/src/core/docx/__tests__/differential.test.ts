/**
 * Smoke test for the differential testing harness.
 *
 * Proves the harness wired in `packages/folio/scripts/differential/`
 * runs end-to-end against a real fixture and surfaces zero divergences
 * for a parse the team already considers correct. The smoke test does
 * NOT lock in equivalence for the whole corpus — adding more fixtures
 * is intentionally a follow-up so a single PR does not commit the
 * project to maintaining differential parity across the entire fixture
 * suite.
 *
 * If python-docx is not installed on the host (or python3 is missing),
 * the test is skipped rather than failing. This lets contributors
 * without the optional Python dependency run `bun test` cleanly. See
 * `packages/folio/scripts/differential/README.md` for setup.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { runDifferential } from "../../../../scripts/differential/diff";

const FIXTURE_PATH = join(
  import.meta.dir,
  "__fixtures__",
  "regressions",
  "repack-paragraph-sectpr.docx",
);

const isPythonDocxAvailable = (): boolean => {
  const result = spawnSync("python3", ["-c", "import docx"], {
    encoding: "utf-8",
    timeout: 5000,
  });
  return !result.error && result.status === 0;
};

describe("differential parser harness (folio vs python-docx)", () => {
  if (!isPythonDocxAvailable()) {
    test.skip("python-docx not installed; see scripts/differential/README.md", () => {});
    return;
  }

  test("structural projection matches python-docx for a known-good fixture", async () => {
    const result = await runDifferential(FIXTURE_PATH);
    if (!result.ok) {
      if (result.reason === "infra") {
        throw new Error(`harness infrastructure failure: ${result.message}`);
      }
      throw new Error(
        `unexpected divergence on smoke fixture:\n${JSON.stringify(result.divergences, null, 2)}\n\nfolio: ${JSON.stringify(result.folio, null, 2)}\nreference: ${JSON.stringify(result.reference, null, 2)}`,
      );
    }
    expect(result.ok).toBe(true);
    // Sanity: confirm the projection actually walked the document
    // rather than returning trivial zeroes that would also match.
    expect(result.folio.totalParagraphs).toBeGreaterThan(0);
    expect(result.folio.totalTables).toBeGreaterThan(0);
  });
});

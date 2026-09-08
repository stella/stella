/**
 * The seeded analyses must still name the input they describe.
 *
 * A stored analysis is served only while its `inputFingerprint` matches the
 * digest of the decision's anchored text and the system prompt its language
 * resolves to. Editing an analysis prompt therefore invalidates every stored
 * analysis, which is deliberate in production (the next open regenerates) and
 * fatal for the fixtures, which have no model to regenerate with: the reader
 * silently loses its outline, and the only thing that noticed was a marketing
 * screenshot capture two jobs downstream.
 *
 * This is that notice, moved to where a prompt change is made. When it fails,
 * run `bun run apps/api/scripts/refresh-case-law-fixture-analyses.ts` and
 * commit the fixtures.
 */

import { describe, expect, test } from "bun:test";

import { readCaseLawFixtureAnalyses } from "./lib/case-law-fixture-analyses";

describe("seeded case-law analyses", () => {
  test("every stored analysis names the input it would be served for", async () => {
    const files = await readCaseLawFixtureAnalyses();
    const entries = files.flatMap((file) => file.entries);

    // A fixture set that carries no analysis at all would pass vacuously,
    // and the reader it exists to furnish would have no outline to show.
    expect(entries.length).toBeGreaterThan(0);

    expect(
      entries
        .filter((entry) => !entry.matches)
        .map((entry) => `${entry.fixtureName} ${entry.caseNumber}`),
    ).toEqual([]);
  });
});

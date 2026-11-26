import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  LEAKING_CALLS,
  REFERENCE_CALLS,
  scoreSiteNotesRun,
  SITE_NOTES_CASES,
} from "./site-notes-cases";

describe("site-note tool contract", () => {
  test("the reference calls score full marks through the tools' own schemas", () => {
    for (const testCase of SITE_NOTES_CASES) {
      const score = scoreSiteNotesRun(
        testCase,
        REFERENCE_CALLS[testCase.id] ?? [],
      );
      expect(score).toEqual({
        caseId: testCase.id,
        readsFirst: true,
        parses: true,
        clean: true,
        confirms: true,
        replacesOrRemoves: true,
        adds: true,
        rejected: [],
      });
    }
  });

  test("a note that carries the member's work is caught", () => {
    for (const [caseId, calls] of Object.entries(LEAKING_CALLS)) {
      const testCase =
        SITE_NOTES_CASES.find(({ id }) => id === caseId) ??
        panic(`No case ${caseId}`);
      expect(scoreSiteNotesRun(testCase, calls).clean).toBe(false);
    }
  });

  test("a run that browses before reading the notes, or keeps a stale note, fails", () => {
    const changed =
      SITE_NOTES_CASES.find(({ id }) => id === "site-changed") ??
      panic("No site-changed case");
    const score = scoreSiteNotesRun(changed, [
      {
        name: "mcp__stella__save_site_notes",
        args: {
          url: "https://research.example.org",
          changes: [
            { type: "confirm", id: "01990000-0000-7000-8000-0000000000b2" },
          ],
        },
      },
    ]);
    expect(score.readsFirst).toBe(false);
    expect(score.replacesOrRemoves).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";

import { advanceLegislationCorpusStorageResume } from "@/api/lib/legal-search/legislation-corpus-storage-backfill";

const page = (...rows: [string, boolean][]) =>
  rows.map(([id, failed]) => ({ id, failed }));

describe("advanceLegislationCorpusStorageResume", () => {
  test("advances to the last id of a page with no failure", () => {
    expect(
      advanceLegislationCorpusStorageResume(
        { after: "a", held: false },
        page(["b", false], ["c", false]),
      ),
    ).toEqual({ after: "c", held: false });
  });

  test("stops before the first failed document and stays there", () => {
    const first = advanceLegislationCorpusStorageResume(
      { after: "a", held: false },
      page(["b", false], ["c", true], ["d", false]),
    );
    expect(first).toEqual({ after: "b", held: true });
    expect(
      advanceLegislationCorpusStorageResume(first, page(["e", false])),
    ).toEqual({ after: "b", held: true });
  });

  test("a failure first in the run keeps the starting cursor, including none", () => {
    expect(
      advanceLegislationCorpusStorageResume(
        { after: null, held: false },
        page(["a", true], ["b", false]),
      ),
    ).toEqual({ after: null, held: true });
    expect(
      advanceLegislationCorpusStorageResume(
        { after: "x", held: false },
        page(["y", true]),
      ),
    ).toEqual({ after: "x", held: true });
  });

  test("resuming after the printed cursor reaches every failed document", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const failed = new Set(["c", "e"]);
    let resume = { after: null as string | null, held: false };
    for (const chunk of [ids.slice(0, 2), ids.slice(2, 4), ids.slice(4)]) {
      resume = advanceLegislationCorpusStorageResume(
        resume,
        chunk.map((id) => ({ id, failed: failed.has(id) })),
      );
    }
    const retried = ids.filter(
      (id) => resume.after === null || id > resume.after,
    );
    for (const id of failed) {
      expect(retried).toContain(id);
    }
  });
});

import { describe, expect, test } from "bun:test";

import {
  diffProvisionText,
  resolveSelectedVersion,
  selectChangedVersions,
} from "@/features/statutes/provision-diff";
import type { ProvisionDiffSegment } from "@/features/statutes/provision-diff";

const rebuild = (
  segments: readonly ProvisionDiffSegment[],
  side: "before" | "after",
): string =>
  segments
    .filter(
      (segment) =>
        segment.kind === "equal" ||
        segment.kind === (side === "before" ? "removed" : "inserted"),
    )
    .map((segment) => segment.text)
    .join("");

describe("diffProvisionText", () => {
  test("marks only the words that changed", () => {
    const segments = diffProvisionText(
      "The seller shall deliver within thirty days.",
      "The seller shall deliver within fourteen days.",
    );

    expect(segments.filter((segment) => segment.kind !== "equal")).toEqual([
      { kind: "removed", text: "thirty" },
      { kind: "inserted", text: "fourteen" },
    ]);
  });

  test("rebuilds both wordings exactly", () => {
    const before = "A party may withdraw from the contract within ten days.";
    const after = "A party may, in writing, withdraw from the contract.";
    const segments = diffProvisionText(before, after);

    expect(rebuild(segments, "before")).toBe(before);
    expect(rebuild(segments, "after")).toBe(after);
  });

  test("keeps identical wordings as a single unchanged run", () => {
    const text = "The obligation expires on performance.";

    expect(diffProvisionText(text, text)).toEqual([{ kind: "equal", text }]);
  });

  test("reports a repeal as a removal with nothing inserted", () => {
    const segments = diffProvisionText("The rule applies.", "");

    expect(segments).toEqual([{ kind: "removed", text: "The rule applies." }]);
  });

  test("reports a new provision as an insertion with nothing removed", () => {
    const segments = diffProvisionText("", "The rule applies.");

    expect(segments).toEqual([{ kind: "inserted", text: "The rule applies." }]);
  });

  test("never emits two adjacent segments of the same kind", () => {
    const segments = diffProvisionText(
      "one two three four five six",
      "one nine three ten five eleven",
    );

    for (const [index, segment] of segments.entries()) {
      expect(segments.at(index + 1)?.kind).not.toBe(segment.kind);
    }
  });

  test("falls back to a wholesale replacement past the alignment limit", () => {
    // Long enough that a quadratic alignment is the wrong tool; the fixture
    // must exceed the limit or the assertion proves nothing.
    const before = Array.from({ length: 2000 }, (_, i) => `a${i}`).join(" ");
    const after = Array.from({ length: 2000 }, (_, i) => `b${i}`).join(" ");
    const segments = diffProvisionText(before, after);

    expect(segments).toEqual([
      { kind: "removed", text: before },
      { kind: "inserted", text: after },
    ]);
  });

  test("still aligns a long provision with a shared prefix and suffix", () => {
    // The same length, but only one word differs, so trimming the common ends
    // leaves an alignment well inside the limit.
    const words = Array.from({ length: 2000 }, (_, i) => `w${i}`);
    const before = words.join(" ");
    const after = words.with(1000, "changed").join(" ");
    const segments = diffProvisionText(before, after);

    expect(segments.filter((segment) => segment.kind !== "equal")).toEqual([
      { kind: "removed", text: "w1000" },
      { kind: "inserted", text: "changed" },
    ]);
  });
});

describe("selectChangedVersions", () => {
  test("folds away a consolidation that reissues the wording unchanged", () => {
    const versions = [
      { documentId: "c", text: "new wording" },
      { documentId: "b", text: "old wording" },
      { documentId: "a", text: "old wording" },
    ];

    expect(selectChangedVersions(versions).map((v) => v.documentId)).toEqual([
      "c",
      "a",
    ]);
  });

  test("keeps the earliest wording on record", () => {
    const versions = [{ documentId: "a", text: "only wording" }];

    expect(selectChangedVersions(versions)).toEqual(versions);
  });

  test("keeps every version when each one rewrote the provision", () => {
    const versions = [
      { documentId: "c", text: "third" },
      { documentId: "b", text: "second" },
      { documentId: "a", text: "first" },
    ];

    expect(selectChangedVersions(versions)).toEqual(versions);
  });
});

describe("resolveSelectedVersion", () => {
  // What one page of the history looks like, and what the next page turns it
  // into: the reissue only becomes a repetition once its predecessor loads.
  const firstPage = [
    { documentId: "current", text: "new wording" },
    { documentId: "reissue", text: "old wording" },
  ];
  const bothPages = [
    ...firstPage,
    { documentId: "original", text: "old wording" },
  ];

  test("keeps the reader on the same wording when the next page folds it away", () => {
    // The fixture must actually fold, or the reconciliation proves nothing.
    expect(selectChangedVersions(firstPage).map((v) => v.documentId)).toContain(
      "reissue",
    );
    expect(
      selectChangedVersions(bothPages).map((v) => v.documentId),
    ).not.toContain("reissue");

    const selected = resolveSelectedVersion({
      changed: selectChangedVersions(bothPages),
      consolidations: bothPages,
      selectedId: "reissue",
    });

    expect(selected?.documentId).toBe("original");
    expect(selected?.text).toBe("old wording");
  });

  test("leaves a still-listed selection alone", () => {
    expect(
      resolveSelectedVersion({
        changed: selectChangedVersions(bothPages),
        consolidations: bothPages,
        selectedId: "original",
      })?.documentId,
    ).toBe("original");
  });

  test("defaults to the newest wording with nothing selected", () => {
    expect(
      resolveSelectedVersion({
        changed: selectChangedVersions(bothPages),
        consolidations: bothPages,
        selectedId: null,
      })?.documentId,
    ).toBe("current");
  });

  test("falls back to the newest wording for an unknown selection", () => {
    expect(
      resolveSelectedVersion({
        changed: selectChangedVersions(bothPages),
        consolidations: bothPages,
        selectedId: "not-in-this-work",
      })?.documentId,
    ).toBe("current");
  });

  test("has nothing to resolve to on an empty history", () => {
    expect(
      resolveSelectedVersion({
        changed: [],
        consolidations: [],
        selectedId: "current",
      }),
    ).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";

import {
  resolveSelectedVersion,
  selectChangedVersions,
} from "@/features/statutes/provision-diff";

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
    // Sliced from the fixture so the element type is the real one; empty
    // literals would infer away the return type this asserts on.
    const empty = bothPages.slice(0, 0);

    expect(
      resolveSelectedVersion({
        changed: empty,
        consolidations: empty,
        selectedId: "current",
      }),
    ).toBeUndefined();
  });
});

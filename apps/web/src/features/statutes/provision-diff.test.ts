import { describe, expect, test } from "bun:test";

import { selectChangedVersions } from "@/features/statutes/provision-diff";

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

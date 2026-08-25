import { describe, expect, test } from "bun:test";

import { collectAnnotationPages } from "@/features/case-law/queries/annotations";

describe("collectAnnotationPages", () => {
  test("returns every cursor page before the reader receives annotations", async () => {
    const requestedCursors: Array<string | undefined> = [];

    const items = await collectAnnotationPages(async (cursor) => {
      requestedCursors.push(cursor);

      switch (cursor) {
        case undefined:
          return { items: ["first"], nextCursor: "second-page" };
        case "second-page":
          return { items: ["second"], nextCursor: "third-page" };
        case "third-page":
          return { items: ["third"], nextCursor: null };
      }
    });

    expect(items).toEqual(["first", "second", "third"]);
    expect(requestedCursors).toEqual([undefined, "second-page", "third-page"]);
  });
});

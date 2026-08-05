import { describe, expect, test } from "bun:test";

import {
  classifyDocxFindKeydown,
  resetOpenDocxFindQuery,
} from "./docx-find.logic";

const keyEvent = (
  key: string,
  modifiers: Partial<{
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  }> = {},
) => ({
  altKey: false,
  ctrlKey: false,
  key,
  metaKey: false,
  shiftKey: false,
  ...modifiers,
});

describe("classifyDocxFindKeydown", () => {
  test("claims the bare find shortcut on both platforms", () => {
    for (const modifiers of [{ metaKey: true }, { ctrlKey: true }]) {
      expect(
        classifyDocxFindKeydown({
          event: keyEvent("f", modifiers),
          isOpen: false,
        }),
      ).toEqual({ type: "openFind" });
    }
  });

  test("claims the shortcut regardless of key case", () => {
    expect(
      classifyDocxFindKeydown({
        event: keyEvent("F", { metaKey: true }),
        isOpen: false,
      }),
    ).toEqual({ type: "openFind" });
  });

  // Suppressing Folio's dialog costs a `stopPropagation`, so anything this
  // bar does not handle itself must fall through untouched.
  test("leaves every other modifier combination to Folio", () => {
    const unclaimed = [
      keyEvent("f"),
      keyEvent("f", { altKey: true, metaKey: true }),
      keyEvent("f", { metaKey: true, shiftKey: true }),
      keyEvent("f", { altKey: true, ctrlKey: true }),
      keyEvent("f", { ctrlKey: true, metaKey: true }),
      keyEvent("g", { metaKey: true }),
    ];
    for (const event of unclaimed) {
      expect(classifyDocxFindKeydown({ event, isOpen: true })).toEqual({
        type: "none",
      });
    }
  });

  test("takes Escape only while the bar is open", () => {
    expect(
      classifyDocxFindKeydown({ event: keyEvent("Escape"), isOpen: true }),
    ).toEqual({ type: "closeFind" });
    expect(
      classifyDocxFindKeydown({ event: keyEvent("Escape"), isOpen: false }),
    ).toEqual({ type: "none" });
  });
});

describe("resetOpenDocxFindQuery", () => {
  test("invalidates stale navigation state before the new search runs", () => {
    const state = resetOpenDocxFindQuery(
      {
        status: "open",
        activeIndex: 2,
        focusSeq: 4,
        query: "old query",
        summary: { count: 5, truncated: true },
      },
      "new query",
    );

    expect(state).toEqual({
      status: "open",
      activeIndex: 0,
      focusSeq: 4,
      query: "new query",
      summary: { count: 0, truncated: false },
    });
  });
});

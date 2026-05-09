import { describe, expect, test } from "bun:test";

import { createPaginator } from "./paginator";

const SIZE = { w: 800, h: 1000 };
const MARGINS = { top: 50, right: 50, bottom: 50, left: 50 };

describe("paginator forcePageBreak", () => {
  test("two consecutive forcePageBreak calls preserve an explicit blank page", () => {
    const paginator = createPaginator({ pageSize: SIZE, margins: MARGINS });
    paginator.forcePageBreak();
    paginator.forcePageBreak();

    expect(paginator.pages.length).toBe(2);
  });

  test("coalesceBlankPage reuses an empty page with the active layout", () => {
    const paginator = createPaginator({ pageSize: SIZE, margins: MARGINS });
    paginator.forcePageBreak({ coalesceBlankPage: true });
    paginator.forcePageBreak({ coalesceBlankPage: true });

    expect(paginator.pages.length).toBe(1);
  });

  test("forcePageBreak after content followed by another forcePageBreak preserves a blank page", () => {
    const paginator = createPaginator({ pageSize: SIZE, margins: MARGINS });
    const state = paginator.getCurrentState();
    state.cursorY += 100;
    state.page.fragments.push({ kind: "paragraph" } as never);

    paginator.forcePageBreak();
    paginator.forcePageBreak();

    expect(paginator.pages.length).toBe(3);
  });

  test("forcePageBreak creates a fresh blank page after the active layout changes", () => {
    const paginator = createPaginator({ pageSize: SIZE, margins: MARGINS });
    paginator.forcePageBreak();

    const nextSize = { w: 600, h: 700 };
    const nextMargins = { top: 30, right: 40, bottom: 50, left: 60 };
    paginator.updatePageLayout(nextSize, nextMargins);
    const state = paginator.forcePageBreak({ coalesceBlankPage: true });

    expect(paginator.pages.length).toBe(2);
    expect(state.page.size).toEqual(nextSize);
    expect(state.page.margins).toEqual(nextMargins);
    expect(state.topMargin).toBe(nextMargins.top);
    expect(state.contentBottom).toBe(nextSize.h - nextMargins.bottom);
  });
});

describe("paginator block spacing", () => {
  test("does not carry trailing spacing to the top of a new page", () => {
    const paginator = createPaginator({
      pageSize: { w: 100, h: 100 },
      margins: { top: 10, right: 10, bottom: 10, left: 10 },
    });

    paginator.addFragment({ kind: "paragraph" } as never, 70, 0, 20);
    const result = paginator.addFragment(
      { kind: "paragraph" } as never,
      20,
      0,
      0,
    );

    expect(paginator.pages.length).toBe(2);
    expect(result.y).toBe(10);
  });

  test("preserves explicit spaceBefore at the top of a new page", () => {
    const paginator = createPaginator({
      pageSize: { w: 100, h: 100 },
      margins: { top: 10, right: 10, bottom: 10, left: 10 },
    });

    paginator.addFragment({ kind: "paragraph" } as never, 70, 0, 20);
    const result = paginator.addFragment(
      { kind: "paragraph" } as never,
      20,
      5,
      0,
    );

    expect(paginator.pages.length).toBe(2);
    expect(result.y).toBe(15);
  });
});

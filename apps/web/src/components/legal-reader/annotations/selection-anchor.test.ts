import { expect, test } from "bun:test";

import {
  isInnermostAnchoredBlock,
  isReaderChromeParent,
  readerAnnotationActivationAction,
  readerSelectionContainmentAction,
} from "@/components/legal-reader/annotations/selection-anchor";

test("detached selection text remains document content", () => {
  expect(isReaderChromeParent(null)).toBe(false);
});

test("a reader drag restores its last endpoint instead of entering adjacent UI", () => {
  expect(
    readerSelectionContainmentAction({
      anchor: "inside",
      drag: "active",
      focus: "outside",
      snapshot: "available",
    }),
  ).toBe("restore");
});

test("selection containment preserves reader and Inspector-native gestures", () => {
  expect(
    readerSelectionContainmentAction({
      anchor: "inside",
      drag: "active",
      focus: "inside",
      snapshot: "available",
    }),
  ).toBe("remember");
  expect(
    readerSelectionContainmentAction({
      anchor: "outside",
      drag: "active",
      focus: "inside",
      snapshot: "available",
    }),
  ).toBe("ignore");
  expect(
    readerSelectionContainmentAction({
      anchor: "inside",
      drag: "inactive",
      focus: "outside",
      snapshot: "available",
    }),
  ).toBe("ignore");
  expect(
    readerSelectionContainmentAction({
      anchor: "inside",
      drag: "active",
      focus: "outside",
      snapshot: "empty",
    }),
  ).toBe("ignore");
});

test("a mark activates only after a click, never during a text drag", () => {
  expect(
    readerAnnotationActivationAction({
      selection: "collapsed",
      target: "annotation",
    }),
  ).toBe("activate");
  expect(
    readerAnnotationActivationAction({
      selection: "range",
      target: "annotation",
    }),
  ).toBe("ignore");
  expect(
    readerAnnotationActivationAction({
      selection: "collapsed",
      target: "other",
    }),
  ).toBe("ignore");
});

test("a table is a container; the cell the words are in owns the mark", () => {
  // `contains` is the whole of what the rule reads, so plain fakes state the
  // nesting exactly as the DOM would report it.
  type Fake = { contains: (other: Fake | null) => boolean; name: string };
  const cells: Fake[] = ["cell-0", "cell-1"].map((name) => ({
    contains: (other) => other?.name === name,
    name,
  }));
  const table: Fake = {
    contains: () => true,
    name: "table",
  };
  const paragraph: Fake = {
    contains: (other) => other?.name === "paragraph",
    name: "paragraph",
  };
  const anchored = [table, ...cells, paragraph];

  expect(isInnermostAnchoredBlock(table, anchored)).toBe(false);
  for (const cell of cells) {
    expect(isInnermostAnchoredBlock(cell, anchored)).toBe(true);
  }
  expect(isInnermostAnchoredBlock(paragraph, anchored)).toBe(true);
});

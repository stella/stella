import { expect, test } from "bun:test";

import {
  isReaderChromeParent,
  readerAnnotationActivationAction,
  readerSelectionContainmentAction,
} from "@/features/case-law/annotations/selection-anchor";

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

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  applySelectionGesture,
  SELECTION_GESTURE,
  selectionGestureForModifiers,
} from "./multi-selection.logic";
import type { MultiSelection } from "./multi-selection.logic";

const COLUMN = ["a", "b", "c", "d", "e"];

const PROPERTY_MIN_ID_LENGTH = 1;
const PROPERTY_MAX_ID_LENGTH = 3;
const PROPERTY_MIN_COLUMN_LENGTH = 1;
const PROPERTY_MAX_COLUMN_LENGTH = 20;

const selection = (
  ids: readonly string[],
  anchorId: string | null,
): MultiSelection => ({ selectedIds: new Set(ids), anchorId });

const ids = (value: MultiSelection) => [...value.selectedIds].toSorted();

describe("multi-selection gestures", () => {
  test("a plain click on a replacing surface selects only the clicked item", () => {
    const next = applySelectionGesture({
      selection: selection(["a", "c"], "a"),
      gesture: SELECTION_GESTURE.replace,
      id: "c",
      orderedIds: COLUMN,
    });

    expect(ids(next)).toEqual(["c"]);
    expect(next.anchorId).toBe("c");
  });

  test("an exclusive toggle clears a selection that was only the clicked item", () => {
    const next = applySelectionGesture({
      selection: selection(["b"], "b"),
      gesture: SELECTION_GESTURE.exclusiveToggle,
      id: "b",
      orderedIds: COLUMN,
    });

    expect(ids(next)).toEqual([]);
    expect(next.anchorId).toBe("b");
  });

  test("an exclusive toggle collapses a larger selection onto the clicked item", () => {
    const next = applySelectionGesture({
      selection: selection(["a", "b"], "a"),
      gesture: SELECTION_GESTURE.exclusiveToggle,
      id: "b",
      orderedIds: COLUMN,
    });

    expect(ids(next)).toEqual(["b"]);
  });

  test("a toggle adds and removes one item and moves the anchor to it", () => {
    const added = applySelectionGesture({
      selection: selection(["a"], "a"),
      gesture: SELECTION_GESTURE.toggle,
      id: "d",
      orderedIds: COLUMN,
    });
    expect(ids(added)).toEqual(["a", "d"]);
    expect(added.anchorId).toBe("d");

    const removed = applySelectionGesture({
      selection: added,
      gesture: SELECTION_GESTURE.toggle,
      id: "a",
      orderedIds: COLUMN,
    });
    expect(ids(removed)).toEqual(["d"]);
  });

  test("a range spans the column from the anchor in either direction and keeps the anchor", () => {
    const down = applySelectionGesture({
      selection: selection(["b"], "b"),
      gesture: SELECTION_GESTURE.extend,
      id: "d",
      orderedIds: COLUMN,
    });
    expect(ids(down)).toEqual(["b", "c", "d"]);
    expect(down.anchorId).toBe("b");

    const up = applySelectionGesture({
      selection: down,
      gesture: SELECTION_GESTURE.extend,
      id: "a",
      orderedIds: COLUMN,
    });
    expect(ids(up)).toEqual(["a", "b"]);
    expect(up.anchorId).toBe("b");
  });

  test("a range whose anchor lies outside the column selects the clicked item alone", () => {
    const next = applySelectionGesture({
      selection: selection(["x"], "x"),
      gesture: SELECTION_GESTURE.extend,
      id: "c",
      orderedIds: COLUMN,
    });

    expect(ids(next)).toEqual(["c"]);
    expect(next.anchorId).toBe("c");
  });

  test("a range with no anchor yet selects the clicked item alone", () => {
    const next = applySelectionGesture({
      selection: selection([], null),
      gesture: SELECTION_GESTURE.extend,
      id: "c",
      orderedIds: COLUMN,
    });

    expect(ids(next)).toEqual(["c"]);
  });

  test("Shift wins over Cmd/Ctrl, and an unmodified click means what the surface says", () => {
    expect(
      selectionGestureForModifiers(
        { meta: true, shift: true },
        SELECTION_GESTURE.replace,
      ),
    ).toBe(SELECTION_GESTURE.extend);
    expect(
      selectionGestureForModifiers(
        { meta: true, shift: false },
        SELECTION_GESTURE.replace,
      ),
    ).toBe(SELECTION_GESTURE.toggle);
    expect(
      selectionGestureForModifiers(
        { meta: false, shift: false },
        SELECTION_GESTURE.exclusiveToggle,
      ),
    ).toBe(SELECTION_GESTURE.exclusiveToggle);
  });

  test("multi-selection range is the contiguous run between anchor and target", () => {
    assertProperty(
      "multi-selection range is the contiguous run between anchor and target",
      fc.property(
        fc.uniqueArray(
          fc.string({
            minLength: PROPERTY_MIN_ID_LENGTH,
            maxLength: PROPERTY_MAX_ID_LENGTH,
          }),
          {
            minLength: PROPERTY_MIN_COLUMN_LENGTH,
            maxLength: PROPERTY_MAX_COLUMN_LENGTH,
          },
        ),
        fc.nat(),
        fc.nat(),
        (orderedIds, anchorSeed, targetSeed) => {
          const anchor = orderedIds[anchorSeed % orderedIds.length];
          const target = orderedIds[targetSeed % orderedIds.length];
          if (anchor === undefined || target === undefined) {
            return;
          }
          const next = applySelectionGesture({
            selection: selection([anchor], anchor),
            gesture: SELECTION_GESTURE.extend,
            id: target,
            orderedIds,
          });
          const positions = orderedIds
            .map((id, index) => (next.selectedIds.has(id) ? index : -1))
            .filter((index) => index !== -1);
          const first = positions.at(0) ?? -1;
          const last = positions.at(-1) ?? -1;

          expect(next.selectedIds.has(anchor)).toBe(true);
          expect(next.selectedIds.has(target)).toBe(true);
          expect(last - first + 1).toBe(positions.length);
          expect(next.selectedIds.size).toBe(
            Math.abs(orderedIds.indexOf(anchor) - orderedIds.indexOf(target)) +
              1,
          );
          expect(next.anchorId).toBe(anchor);
        },
      ),
    );
  });
});

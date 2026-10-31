import { panic } from "better-result";

/**
 * A pointer-driven multi-selection over a list of items: the chosen ids and
 * the pivot a Shift-click extends a range from. The file tree and the kanban
 * board share this model so a modifier click means the same thing on both.
 */
export type MultiSelection = {
  selectedIds: ReadonlySet<string>;
  /** The last item chosen by a plain or Cmd/Ctrl click; `null` before one. */
  anchorId: string | null;
};

export const SELECTION_GESTURE = {
  /** This item alone. */
  replace: "replace",
  /** This item alone, or nothing when it already was the whole selection. */
  exclusiveToggle: "exclusive-toggle",
  /** Add or remove this item, keeping the rest (Cmd/Ctrl-click). */
  toggle: "toggle",
  /** Every item from the anchor to this one, inclusive (Shift-click). */
  extend: "extend",
} as const;

export type SelectionGesture =
  (typeof SELECTION_GESTURE)[keyof typeof SELECTION_GESTURE];

type ApplySelectionGestureOptions = {
  selection: MultiSelection;
  gesture: SelectionGesture;
  id: string;
  /**
   * The items a range may span, in display order. Only `extend` reads it; a
   * range whose anchor is outside this order (another column, a collapsed
   * folder) selects the clicked item alone instead.
   */
  orderedIds: readonly string[];
};

const replaceWith = (id: string): MultiSelection => ({
  selectedIds: new Set([id]),
  anchorId: id,
});

export const applySelectionGesture = ({
  selection,
  gesture,
  id,
  orderedIds,
}: ApplySelectionGestureOptions): MultiSelection => {
  switch (gesture) {
    case SELECTION_GESTURE.replace:
      return replaceWith(id);
    case SELECTION_GESTURE.exclusiveToggle:
      if (selection.selectedIds.size === 1 && selection.selectedIds.has(id)) {
        return { selectedIds: new Set(), anchorId: id };
      }
      return replaceWith(id);
    case SELECTION_GESTURE.toggle: {
      const selectedIds = new Set(selection.selectedIds);
      if (selectedIds.has(id)) {
        selectedIds.delete(id);
      } else {
        selectedIds.add(id);
      }
      return { selectedIds, anchorId: id };
    }
    case SELECTION_GESTURE.extend: {
      const from =
        selection.anchorId === null
          ? -1
          : orderedIds.indexOf(selection.anchorId);
      const to = orderedIds.indexOf(id);
      if (from === -1 || to === -1) {
        return replaceWith(id);
      }
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      // The anchor stays put, so a second Shift-click re-ranges from it.
      return {
        selectedIds: new Set(orderedIds.slice(lo, hi + 1)),
        anchorId: selection.anchorId,
      };
    }
    default:
      gesture satisfies never;
      return panic(`Unhandled selection gesture: ${String(gesture)}`);
  }
};

type SelectionModifiers = { meta: boolean; shift: boolean };

/**
 * Shift wins over Cmd/Ctrl, as in the file tree. `plain` is what an
 * unmodified click means on the calling surface.
 */
export const selectionGestureForModifiers = (
  { meta, shift }: SelectionModifiers,
  plain: SelectionGesture,
): SelectionGesture => {
  if (shift) {
    return SELECTION_GESTURE.extend;
  }
  if (meta) {
    return SELECTION_GESTURE.toggle;
  }
  return plain;
};

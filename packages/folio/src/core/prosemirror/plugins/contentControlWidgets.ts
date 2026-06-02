/**
 * Interactive content-control widget delegation.
 *
 * Painted blocks inside a typed SDT carry `data-sdt-type` (checkbox /
 * dropdown / date) and `data-sdt-tag` thanks to `applySdtDataAttrs`. This
 * plugin watches editor-region clicks: when the user clicks inside a typed
 * control it dispatches the appropriate `setContentControlValueTr` so the
 * mutation goes through the normal undo stack.
 *
 * The checkbox path is fully wired (a click toggles the modeled state and
 * the rendered glyph). Dropdown and date paths emit the dispatch hook so the
 * higher-level UI (a popover menu / date picker rendered by the editor
 * shell) can subscribe; the plugin does not own the menu/picker chrome.
 */

import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import {
  ContentControlLockedError,
  ContentControlTypeError,
} from "../../content-controls";
import {
  findBlockSdtMatch,
  setContentControlValueTr,
} from "../commands/contentControls";

export type ContentControlWidgetEvent =
  | {
      kind: "dropdownOpen";
      tag: string;
      sdtType: "dropdown" | "comboBox";
      anchor: HTMLElement;
      listItemsJson: string | undefined;
    }
  | {
      kind: "datePick";
      tag: string;
      anchor: HTMLElement;
      currentValue: string | undefined;
    };

export type ContentControlWidgetCallback = (
  event: ContentControlWidgetEvent,
) => void;

export const contentControlWidgetsPluginKey = new PluginKey<unknown>(
  "contentControlWidgets",
);

function findSdtAncestor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) {
    return null;
  }
  return target.closest<HTMLElement>("[data-sdt-type]");
}

export function createContentControlWidgetsPlugin(
  onEvent: ContentControlWidgetCallback = () => undefined,
): Plugin {
  return new Plugin({
    key: contentControlWidgetsPluginKey,
    props: {
      handleDOMEvents: {
        click(view, event) {
          const anchor = findSdtAncestor(event.target);
          if (!anchor) {
            return false;
          }
          const tag = anchor.dataset["sdtTag"];
          const sdtType = anchor.dataset["sdtType"];
          if (!tag || !sdtType) {
            return false;
          }
          // The lock check happens inside the transaction helper; we just
          // surface the click intent. Errors thrown by the helper are
          // caught here so the editor stays interactive even on refusal.
          try {
            if (sdtType === "checkbox") {
              const current = anchor.dataset["sdtChecked"] === "true";
              const tr = setContentControlValueTr(
                view.state,
                { tag },
                {
                  kind: "checkbox",
                  checked: !current,
                },
              );
              if (tr) {
                view.dispatch(tr);
                event.preventDefault();
                return true;
              }
            } else if (sdtType === "dropdown" || sdtType === "comboBox") {
              onEvent({
                kind: "dropdownOpen",
                tag,
                sdtType,
                anchor,
                listItemsJson: anchor.dataset["sdtListItems"],
              });
              event.preventDefault();
              return true;
            } else if (sdtType === "date") {
              onEvent({
                kind: "datePick",
                tag,
                anchor,
                currentValue: undefined,
              });
              event.preventDefault();
              return true;
            }
          } catch (error) {
            if (
              error instanceof ContentControlLockedError ||
              error instanceof ContentControlTypeError
            ) {
              // Refusal is expected — log to console for debugging but do
              // not break the editor or surface a runtime crash.
              // oxlint-disable-next-line no-console
              console.warn("[content-controls]", error.message);
              return true;
            }
            throw error;
          }
          return false;
        },
      },
    },
    view() {
      // Resolves the helper at plugin-find time so the picker shell can
      // dispatch a tx by tag without re-implementing the lock/type rules.
      return {};
    },
  });
}

/**
 * Stable resolver helpers exposed for the UI shell so a popover menu or
 * date picker can dispatch the same transaction the plugin would.
 */
export function dispatchDropdownPick(
  view: EditorView,
  tag: string,
  value: string,
): boolean {
  const match = findBlockSdtMatch(view.state.doc, { tag });
  if (!match) {
    return false;
  }
  const tr = setContentControlValueTr(
    view.state,
    { tag },
    {
      kind: "dropdown",
      value,
    },
  );
  if (!tr) {
    return false;
  }
  view.dispatch(tr);
  return true;
}

export function dispatchDatePick(
  view: EditorView,
  tag: string,
  date: string,
): boolean {
  const tr = setContentControlValueTr(
    view.state,
    { tag },
    {
      kind: "date",
      date,
    },
  );
  if (!tr) {
    return false;
  }
  view.dispatch(tr);
  return true;
}

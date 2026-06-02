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
      /** PM position of the clicked SDT instance — disambiguates duplicates. */
      pmPos: number;
      sdtType: "dropdown" | "comboBox";
      anchor: HTMLElement;
      listItemsJson: string | undefined;
    }
  | {
      kind: "datePick";
      tag: string;
      pmPos: number;
      anchor: HTMLElement;
      currentValue: string | undefined;
    }
  | {
      /**
       * The plugin refused a click because the control's `w:lock` or type
       * forbade the interaction. The shell decides how to surface this —
       * toast, telemetry, or no-op. The plugin itself never logs.
       */
      kind: "refused";
      tag: string;
      pmPos: number;
      sdtType: string;
      anchor: HTMLElement;
      error: ContentControlLockedError | ContentControlTypeError;
    };

export type ContentControlWidgetCallback = (
  event: ContentControlWidgetEvent,
) => void;

export const contentControlWidgetsPluginKey = new PluginKey<unknown>(
  "contentControlWidgets",
);

/**
 * CustomEvent name dispatched on the editor view DOM whenever the plugin
 * needs to surface a `ContentControlWidgetEvent` to the React shell. The
 * shell subscribes via `addEventListener` and renders the matching chrome.
 *
 * Using a CustomEvent keeps the plugin from owning a React reference and
 * makes the host's responsibility explicit: receive event → render UI →
 * call dispatchDropdownPick / dispatchDatePick.
 */
export const CONTENT_CONTROL_WIDGET_EVENT_NAME = "folio:content-control-widget";

function findSdtAncestor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) {
    return null;
  }
  return target.closest<HTMLElement>("[data-sdt-type]");
}

export function createContentControlWidgetsPlugin(
  onEvent: ContentControlWidgetCallback = () => undefined,
): Plugin {
  const emit = (
    view: { dom: HTMLElement },
    payload: ContentControlWidgetEvent,
  ): void => {
    onEvent(payload);
    view.dom.dispatchEvent(
      new CustomEvent(CONTENT_CONTROL_WIDGET_EVENT_NAME, {
        detail: payload,
        bubbles: true,
      }),
    );
  };
  return new Plugin({
    key: contentControlWidgetsPluginKey,
    props: {
      handleDOMEvents: {
        click(view, event) {
          const anchor = findSdtAncestor(event.target);
          if (!anchor) {
            return false;
          }
          const tag = anchor.dataset["sdtTag"] ?? "";
          const sdtType = anchor.dataset["sdtType"];
          // pmPos is what addresses the clicked instance unambiguously. The
          // painter stamps it from the SdtGroup; tag is kept on the event
          // for telemetry but is no longer the addressing key.
          const pmPosRaw = anchor.dataset["sdtPmPos"];
          const pmPos = pmPosRaw ? Number.parseInt(pmPosRaw, 10) : Number.NaN;
          if (!sdtType || Number.isNaN(pmPos)) {
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
                { pmPos },
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
              emit(view, {
                kind: "dropdownOpen",
                tag,
                pmPos,
                sdtType,
                anchor,
                listItemsJson: anchor.dataset["sdtListItems"],
              });
              event.preventDefault();
              return true;
            } else if (sdtType === "date") {
              emit(view, {
                kind: "datePick",
                tag,
                pmPos,
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
              // Refusal is expected — emit it through the typed callback
              // and let the editor shell decide what to do (toast,
              // analytics, no-op). The plugin itself stays silent so
              // refusals never end up as ad-hoc console noise.
              emit(view, {
                kind: "refused",
                tag,
                pmPos,
                sdtType,
                anchor,
                error,
              });
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
 *
 * Both take the PM `pmPos` of the clicked SDT (from the widget event's
 * `pmPos` field) so the dispatch lands on the exact instance the user
 * interacted with — duplicate-tag SDTs are no longer ambiguous.
 */
export function dispatchDropdownPick(
  view: EditorView,
  pmPos: number,
  value: string,
): boolean {
  const match = findBlockSdtMatch(view.state.doc, { pmPos });
  if (!match) {
    return false;
  }
  const tr = setContentControlValueTr(
    view.state,
    { pmPos },
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
  pmPos: number,
  date: string,
): boolean {
  const tr = setContentControlValueTr(
    view.state,
    { pmPos },
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

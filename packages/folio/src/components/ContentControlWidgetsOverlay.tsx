/**
 * React shell for the content-control widgets plugin.
 *
 * The plugin (see `core/prosemirror/plugins/contentControlWidgets`) emits a
 * `folio:content-control-widget` CustomEvent on the editor's view DOM
 * whenever the user clicks a typed control. This component subscribes to
 * those events and renders a small floating picker positioned at the
 * anchor element — a dropdown menu for `dropdown` / `comboBox` controls,
 * a native date input for `date` controls — then dispatches back through
 * `dispatchDropdownPick` / `dispatchDatePick` so the change rides the
 * normal undo stack.
 *
 * The component keeps its own dependencies small (native `<select>` /
 * `<input type="date">` rendered via a React portal) so the visual chrome
 * stays consistent with the rest of folio without pulling additional UI
 * primitives into the editor's bundle.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { EditorView } from "prosemirror-view";

import {
  CONTENT_CONTROL_WIDGET_EVENT_NAME,
  dispatchDatePick,
  dispatchDropdownPick,
} from "../core/prosemirror/plugins/contentControlWidgets";
import type { ContentControlWidgetEvent } from "../core/prosemirror/plugins/contentControlWidgets";

type ListItem = { displayText: string; value: string };

type OpenPicker =
  | {
      kind: "dropdown";
      /** PM position addressing the clicked SDT instance. */
      pmPos: number;
      items: ListItem[];
      anchorRect: DOMRect;
    }
  | {
      kind: "date";
      pmPos: number;
      anchorRect: DOMRect;
    };

function parseListItems(raw: string | undefined): ListItem[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const out: ListItem[] = [];
    for (const entry of parsed) {
      if (
        entry !== null &&
        typeof entry === "object" &&
        "displayText" in entry &&
        "value" in entry &&
        typeof (entry as ListItem).displayText === "string" &&
        typeof (entry as ListItem).value === "string"
      ) {
        out.push(entry as ListItem);
      }
    }
    return out;
  } catch {
    return [];
  }
}

type ContentControlWidgetsOverlayProps = {
  /**
   * Resolver for the live editor view. Called every render so the host can
   * defer/recreate the view without re-mounting this overlay.
   */
  getEditorView: () => EditorView | null;
};

export function ContentControlWidgetsOverlay({
  getEditorView,
}: ContentControlWidgetsOverlayProps) {
  const [open, setOpen] = useState<OpenPicker | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => setOpen(null), []);

  useEffect(() => {
    const view = getEditorView();
    if (!view) {
      return;
    }
    const target = view.dom;
    containerRef.current = target;
    const onWidget = (event: Event): void => {
      const custom = event as CustomEvent<ContentControlWidgetEvent>;
      const detail = custom.detail;
      if (detail.kind === "dropdownOpen") {
        const items = parseListItems(detail.listItemsJson);
        setOpen({
          kind: "dropdown",
          pmPos: detail.pmPos,
          items,
          anchorRect: detail.anchor.getBoundingClientRect(),
        });
        return;
      }
      if (detail.kind === "datePick") {
        setOpen({
          kind: "date",
          pmPos: detail.pmPos,
          anchorRect: detail.anchor.getBoundingClientRect(),
        });
      }
      // "refused" is delivered for the host's logging hook; the overlay
      // intentionally does not render anything for it.
    };
    target.addEventListener(CONTENT_CONTROL_WIDGET_EVENT_NAME, onWidget);
    return () => {
      target.removeEventListener(CONTENT_CONTROL_WIDGET_EVENT_NAME, onWidget);
    };
  }, [getEditorView]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        close();
      }
    };
    const onScroll = (): void => close();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, close]);

  const style = useMemo(() => {
    if (!open) {
      return undefined;
    }
    return {
      position: "fixed" as const,
      top: `${open.anchorRect.bottom + 4}px`,
      left: `${open.anchorRect.left}px`,
      zIndex: 9999,
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const onDropdownPick = (value: string): void => {
    const view = getEditorView();
    if (view) {
      dispatchDropdownPick(view, open.pmPos, value);
    }
    close();
  };

  const onDatePick = (value: string): void => {
    const view = getEditorView();
    if (view && value.length > 0) {
      dispatchDatePick(view, open.pmPos, value);
    }
    close();
  };

  return createPortal(
    <div
      role="dialog"
      aria-label={open.kind === "dropdown" ? "Dropdown options" : "Pick a date"}
      style={style}
      className="bg-popover text-popover-foreground min-w-[10rem] rounded-md border p-2 shadow-md"
    >
      {open.kind === "dropdown" && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {open.items.length === 0 ? (
            <li className="text-muted-foreground px-2 py-1 text-sm">
              No options
            </li>
          ) : (
            open.items.map((item) => (
              <li key={`${item.value}::${item.displayText}`}>
                <button
                  type="button"
                  onClick={() => onDropdownPick(item.value)}
                  className="hover:bg-accent focus:bg-accent w-full rounded px-2 py-1 text-start focus:outline-none"
                >
                  {item.displayText}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
      {open.kind === "date" && (
        <input
          type="date"
          autoFocus
          onChange={(event) => onDatePick(event.currentTarget.value)}
          className="bg-background rounded border px-2 py-1 text-sm"
        />
      )}
    </div>,
    document.body,
  );
}

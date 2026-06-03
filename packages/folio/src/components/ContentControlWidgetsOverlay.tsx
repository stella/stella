/**
 * React shell for the content-control widgets plugin.
 *
 * The plugin (see `core/prosemirror/plugins/contentControlWidgets`) emits a
 * `folio:content-control-widget` CustomEvent on the editor's view DOM
 * whenever the user clicks a typed control. This component subscribes to
 * those events and renders a small floating picker positioned at the
 * anchor element — a list of menu items for dropdown / comboBox
 * controls, a native date input for date controls — then dispatches back
 * through `dispatchDropdownPick` / `dispatchDatePick` so the change rides
 * the normal undo stack.
 *
 * The dropdown popover uses `@stll/ui` `MenuItem` styling for visual + a11y
 * consistency with the rest of the editor.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { EditorView } from "prosemirror-view";
import { useTranslations } from "use-intl";

import { MenuItem } from "@stll/ui/components/menu";

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
   * Resolver for the live editor view. Stored in a ref so the parent can
   * pass a fresh function each render without triggering listener churn —
   * the subscription only re-establishes when the editor view's DOM node
   * actually changes.
   */
  getEditorView: () => EditorView | null;
};

export function ContentControlWidgetsOverlay({
  getEditorView,
}: ContentControlWidgetsOverlayProps) {
  const t = useTranslations("folio");
  const [open, setOpen] = useState<OpenPicker | null>(null);

  // Hold the latest resolver in a ref so the subscription effect's
  // dependency is the underlying view's identity, not the caller's
  // function literal (which changes every parent render).
  const getEditorViewRef = useRef(getEditorView);
  getEditorViewRef.current = getEditorView;

  const close = useCallback(() => setOpen(null), []);

  // Re-subscribe when the editor's view DOM node changes. Tracking the DOM
  // node (not the view object) means we tolerate parent re-renders that
  // hand us a stable view without recreating the listener.
  const view = getEditorView();
  const viewDom = view?.dom ?? null;

  useEffect(() => {
    if (!viewDom) {
      return;
    }
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
      // `refused` is delivered for the host's logging hook; the overlay
      // intentionally does not render anything for it.
    };
    viewDom.addEventListener(CONTENT_CONTROL_WIDGET_EVENT_NAME, onWidget);
    return () => {
      viewDom.removeEventListener(CONTENT_CONTROL_WIDGET_EVENT_NAME, onWidget);
    };
  }, [viewDom]);

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
      insetInlineStart: `${open.anchorRect.left}px`,
      zIndex: 9999,
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const onDropdownPick = (value: string): void => {
    const liveView = getEditorViewRef.current();
    if (liveView) {
      dispatchDropdownPick(liveView, open.pmPos, value);
    }
    close();
  };

  const onDatePick = (value: string): void => {
    const liveView = getEditorViewRef.current();
    if (liveView && value.length > 0) {
      dispatchDatePick(liveView, open.pmPos, value);
    }
    close();
  };

  return createPortal(
    <div
      role="dialog"
      aria-label={
        open.kind === "dropdown"
          ? t("contentControlDropdownAriaLabel")
          : t("contentControlDateAriaLabel")
      }
      style={style}
      className="bg-popover text-popover-foreground min-w-[10rem] rounded-md border p-1 shadow-md"
    >
      {open.kind === "dropdown" && (
        <div role="menu" className="flex flex-col">
          {open.items.length === 0 ? (
            <div className="text-muted-foreground px-2 py-1 text-sm">
              {t("contentControlDropdownNoOptions")}
            </div>
          ) : (
            open.items.map((item) => (
              <MenuItem
                key={`${item.value}::${item.displayText}`}
                onClick={() => onDropdownPick(item.value)}
              >
                {item.displayText}
              </MenuItem>
            ))
          )}
        </div>
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

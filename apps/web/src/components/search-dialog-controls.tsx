import { useRef } from "react";
import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/utils";

type SearchColumnResizeHandleProps = {
  className?: string;
  label: string;
  /** Current width of the column this separator controls (px); the CSS
   * default when the user has not dragged yet. */
  value: number;
  max: number;
  min: number;
  onResize: (clientX: number) => void;
};

const SEARCH_RESIZE_KEYBOARD_STEP_PX = 16;

/**
 * Drag strip between two columns, mirroring the inspector pane's resize
 * handle. A 4px grab zone straddling the adjacent column border via
 * negative margins, so it adds no visible width of its own. Also a
 * focusable `separator`: arrow keys move it by a fixed step in the pressed
 * physical direction, feeding the same clamped `onResize` path as a drag
 * (a synthetic clientX offset from the handle's own position).
 */
export const SearchColumnResizeHandle = ({
  className,
  label,
  value,
  max,
  min,
  onResize,
}: SearchColumnResizeHandleProps) => {
  const isDraggingRef = useRef(false);

  return (
    <div
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemax={max}
      aria-valuemin={min}
      aria-valuenow={Math.round(value)}
      className={cn(
        "hover:bg-border active:bg-border focus-visible:bg-border focus-visible:ring-ring z-10 -mx-0.5 w-1 shrink-0 cursor-col-resize focus-visible:ring-1 focus-visible:outline-none",
        className,
      )}
      onKeyDown={(event) => {
        let step: number;
        switch (event.key) {
          case "ArrowLeft":
            step = -SEARCH_RESIZE_KEYBOARD_STEP_PX;
            break;
          case "ArrowRight":
            step = SEARCH_RESIZE_KEYBOARD_STEP_PX;
            break;
          default:
            return;
        }
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        onResize(rect.left + rect.width / 2 + step);
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        isDraggingRef.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (isDraggingRef.current) {
          onResize(event.clientX);
        }
      }}
      onPointerUp={() => {
        isDraggingRef.current = false;
      }}
      onPointerCancel={() => {
        isDraggingRef.current = false;
      }}
      role="separator"
      tabIndex={0}
    />
  );
};

type SearchFooterHintProps = {
  translationKey:
    | "search.hintAskAI"
    | "search.hintClose"
    | "search.hintNavigate"
    | "search.hintOpen";
};

const searchFooterKbd = (chunks: ReactNode) => (
  <kbd className="border-border bg-muted rounded border px-1 py-0.5 text-[0.625rem] leading-none">
    {chunks}
  </kbd>
);

export const SearchFooterHintText = ({
  translationKey,
}: SearchFooterHintProps) => {
  const t = useTranslations();
  return <>{t.rich(translationKey, { kbd: searchFooterKbd })}</>;
};

// Keyboard hints mean nothing on touch viewports; below `sm` only the
// footer's clickable controls (the Ask AI button) stay visible.
export const SearchFooterHint = ({ translationKey }: SearchFooterHintProps) => (
  <span className="hidden whitespace-nowrap sm:inline">
    <SearchFooterHintText translationKey={translationKey} />
  </span>
);

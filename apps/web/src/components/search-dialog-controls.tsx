import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { ResizeSeparator } from "@stll/ui/separator";

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
 * Drag strip between two search columns, mirroring the inspector pane's
 * resize handle; arrow keys move it by a fixed step.
 */
export const SearchColumnResizeHandle = (
  props: SearchColumnResizeHandleProps,
) => (
  <ResizeSeparator keyboardStep={SEARCH_RESIZE_KEYBOARD_STEP_PX} {...props} />
);

type SearchFooterHintProps = {
  translationKey:
    | "search.hintAskAI"
    | "search.hintClear"
    | "search.hintClose"
    | "search.hintNavigate"
    | "search.hintOpen";
};

const searchFooterKbd = (chunks: ReactNode) => (
  <kbd className="border-border bg-muted text-3xs rounded border px-1 py-0.5 leading-none">
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

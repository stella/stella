/**
 * Formatting Toolbar Component
 *
 * A toolbar with formatting controls for the DOCX editor:
 * - Font family picker
 * - Bold (Ctrl+B), Italic (Ctrl+I), Underline (Ctrl+U), Strikethrough
 * - Superscript, Subscript buttons
 * - Shows active state for current selection formatting
 * - Applies formatting to selection
 *
 * Classic single-row layout: menus (File, Format, Insert) + formatting icons.
 * Uses FormattingBar internally for the icon toolbar.
 */

import React, { useCallback, useRef } from "react";

import { cn } from "../lib/utils";
import { FormattingBar } from "./FormattingBar";
import {
  ToolbarButton,
  ToolbarGroup,
  ToolbarSeparator,
} from "./toolbarPrimitives";
import type {
  SelectionFormatting,
  FormattingAction,
  ToolbarProps,
  ToolbarButtonProps,
  ToolbarGroupProps,
} from "./toolbarPrimitives";

// Re-export types and primitives so existing consumers keep working
export {
  ToolbarButton,
  ToolbarGroup,
  ToolbarSeparator,
};
export type {
  SelectionFormatting,
  FormattingAction,
  ToolbarProps,
  ToolbarButtonProps,
  ToolbarGroupProps,
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

/**
 * Classic single-row formatting toolbar: menus + formatting icons.
 * Uses FormattingBar internally with inline mode so everything stays in one flex row.
 */
export function Toolbar({
  children,
  className,
  style,
  disabled = false,
  onFormat,
  onPrint,
  showPrintButton = true,
  onPageSetup,
  onInsertImage,
  onInsertTable,
  showTableInsert = true,
  onInsertPageBreak,
  onInsertTOC,
  onRefocusEditor,
  ...restProps
}: ToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);

  const handleToolbarMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const isInteractive =
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.tagName === "OPTION";

    if (!isInteractive) {
      e.preventDefault();
    }
  }, []);

  const handleToolbarMouseUp = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      const activeEl = document.activeElement as HTMLElement;
      const isSelectActive =
        target.tagName === "SELECT" ||
        target.tagName === "OPTION" ||
        activeEl?.tagName === "SELECT";

      if (isSelectActive) {
        return;
      }

      requestAnimationFrame(() => {
        onRefocusEditor?.();
      });
    },
    [onRefocusEditor],
  );

  return (
    <div
      ref={toolbarRef}
      className={cn(
        "flex h-11 items-center justify-center overflow-x-auto border-b border-[var(--doc-border)] bg-[var(--doc-page)] px-1 py-1",
        className,
      )}
      style={style}
      role="toolbar"
      aria-label="Formatting toolbar"
      data-testid="toolbar"
      onMouseDown={handleToolbarMouseDown}
      onMouseUp={handleToolbarMouseUp}
    >
      {/* Formatting icons — rendered inline (display:contents) */}
      <FormattingBar
        {...restProps}
        disabled={disabled}
        onFormat={onFormat}
        onRefocusEditor={onRefocusEditor}
        onInsertTable={onInsertTable}
        showTableInsert={showTableInsert}
        onInsertImage={onInsertImage}
        onInsertPageBreak={onInsertPageBreak}
        onInsertTOC={onInsertTOC}
        onPrint={onPrint}
        showPrintButton={showPrintButton}
        onPageSetup={onPageSetup}
        inline
      >
        {children}
      </FormattingBar>
    </div>
  );
}

// ============================================================================
// RE-EXPORTED UTILITIES (from toolbarUtils.ts)
// ============================================================================

export {
  getSelectionFormatting,
  applyFormattingAction,
  hasActiveFormatting,
  mapHexToHighlightName,
} from "./toolbarUtils";


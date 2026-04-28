/**
 * Toolbar Primitives
 *
 * Shared UI building blocks for toolbar components.
 * Extracted to avoid circular imports between Toolbar and FormattingBar.
 */

import React from "react";
import type { CSSProperties, ReactNode } from "react";

import type {
  ColorValue,
  ParagraphAlignment,
  Style,
  Theme,
} from "../core/types/document";
import { cn } from "../lib/utils";
import type { ListState } from "./ui/ListButtons";
import type { TableAction } from "./ui/table-types";
import { Tooltip } from "./ui/Tooltip";

// ============================================================================
// TYPES
// ============================================================================

/**
 * Current formatting state of the selection
 */
export type SelectionFormatting = {
  /** Whether selected text is bold */
  bold?: boolean | undefined;
  /** Whether selected text is italic */
  italic?: boolean | undefined;
  /** Whether selected text is underlined */
  underline?: boolean | undefined;
  /** Whether selected text has strikethrough */
  strike?: boolean | undefined;
  /** Whether selected text is superscript */
  superscript?: boolean | undefined;
  /** Whether selected text is subscript */
  subscript?: boolean | undefined;
  /** Font family of selected text */
  fontFamily?: string | undefined;
  /** Font size of selected text (in half-points) */
  fontSize?: number | undefined;
  /** Text color */
  color?: string | undefined;
  /** Highlight color */
  highlight?: string | undefined;
  /** Paragraph alignment */
  alignment?: ParagraphAlignment | undefined;
  /** List state of the current paragraph */
  listState?: ListState | undefined;
  /** Line spacing in twips (OOXML value, 240 = single spacing) */
  lineSpacing?: number | undefined;
  /** Paragraph style ID */
  styleId?: string | undefined;
  /** Paragraph left indentation in twips */
  indentLeft?: number | undefined;
  /** Whether the paragraph is RTL (bidi) */
  bidi?: boolean | undefined;
};

/**
 * Formatting action types
 */
export type FormattingAction =
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "superscript"
  | "subscript"
  | "clearFormatting"
  | "bulletList"
  | "numberedList"
  | "indent"
  | "outdent"
  | "insertLink"
  | "insertPageBreak"
  | "setRtl"
  | "setLtr"
  | { type: "fontFamily"; value: string }
  | { type: "fontSize"; value: number }
  | { type: "textColor"; value: ColorValue | string }
  | { type: "highlightColor"; value: string }
  | { type: "alignment"; value: ParagraphAlignment }
  | { type: "lineSpacing"; value: number }
  | { type: "applyStyle"; value: string };

/**
 * Props for the Toolbar component
 */
export type ToolbarProps = {
  /** Current formatting of the selection */
  currentFormatting?: SelectionFormatting | undefined;
  /** Callback when a formatting action is triggered */
  onFormat?: ((action: FormattingAction) => void) | undefined;
  /** Callback for undo action */
  onUndo?: (() => void) | undefined;
  /** Callback for redo action */
  onRedo?: (() => void) | undefined;
  /** Whether undo is available */
  canUndo?: boolean | undefined;
  /** Whether redo is available */
  canRedo?: boolean | undefined;
  /** Whether the toolbar is disabled */
  disabled?: boolean | undefined;
  /** Additional CSS class name */
  className?: string | undefined;
  /** Additional inline styles */
  style?: CSSProperties | undefined;
  /** Whether to enable keyboard shortcuts (default: true) */
  enableShortcuts?: boolean | undefined;
  /** Ref to the editor container for keyboard events */
  editorRef?: React.RefObject<HTMLElement> | undefined;
  /** Custom toolbar items to render */
  children?: ReactNode | undefined;
  /** Whether to show font family picker (default: true) */
  showFontPicker?: boolean | undefined;
  /** Whether to show font size picker (default: true) */
  showFontSizePicker?: boolean | undefined;
  /** Whether to show text color picker (default: true) */
  showTextColorPicker?: boolean | undefined;
  /** Whether to show highlight color picker (default: true) */
  showHighlightColorPicker?: boolean | undefined;
  /** Whether to show alignment buttons (default: true) */
  showAlignmentButtons?: boolean | undefined;
  /** Whether to show list buttons (default: true) */
  showListButtons?: boolean | undefined;
  /** Whether to show line spacing picker (default: true) */
  showLineSpacingPicker?: boolean | undefined;
  /** Whether to show style picker (default: true) */
  showStylePicker?: boolean | undefined;
  /** Document styles for the style picker */
  documentStyles?: Style[] | undefined;
  /** Theme for the style picker */
  theme?: Theme | null | undefined;
  /** Callback for print action */
  onPrint?: (() => void) | undefined;
  /** Whether to show print button (default: true) */
  showPrintButton?: boolean | undefined;
  /** Whether to show zoom control (default: true) */
  showZoomControl?: boolean | undefined;
  /** Current zoom level (1.0 = 100%) */
  zoom?: number | undefined;
  /** Callback when zoom changes */
  onZoomChange?: ((zoom: number) => void) | undefined;
  /** Callback to refocus the editor after toolbar interactions */
  onRefocusEditor?: (() => void) | undefined;
  /** Callback when a table should be inserted */
  onInsertTable?: ((rows: number, columns: number) => void) | undefined;
  /** Whether to show table insert button (default: true) */
  showTableInsert?: boolean | undefined;
  /** Callback when user wants to insert an image */
  onInsertImage?: (() => void) | undefined;
  /** Callback when user wants to insert a page break */
  onInsertPageBreak?: (() => void) | undefined;
  /** Callback when user wants to insert a table of contents */
  onInsertTOC?: (() => void) | undefined;
  /** Callback when user wants to insert a shape */
  onInsertShape?: (data: {
    shapeType: string;
    width: number;
    height: number;
    fillColor?: string | undefined;
    fillType?: string | undefined;
    outlineWidth?: number | undefined;
    outlineColor?: string | undefined;
  }) => void;
  /** Image context when an image is selected */
  imageContext?: {
    wrapType: string;
    displayMode: string;
    cssFloat: string | null;
  } | null;
  /** Callback when image wrap type changes */
  onImageWrapType?: ((wrapType: string) => void) | undefined;
  /** Callback for image transform (rotate/flip) */
  onImageTransform?: (
    action: "rotateCW" | "rotateCCW" | "flipH" | "flipV",
  ) => void;
  /** Callback to open image properties dialog (alt text + border) */
  onOpenImageProperties?: (() => void) | undefined;
  /** Callback to open page setup dialog */
  onPageSetup?: (() => void) | undefined;
  /** Table context when cursor is in a table */
  tableContext?: {
    isInTable: boolean;
    rowCount?: number | undefined;
    columnCount?: number | undefined;
    canSplitCell?: boolean | undefined;
    hasMultiCellSelection?: boolean | undefined;
    cellBorderColor?: ColorValue | undefined;
    cellBackgroundColor?: string | undefined;
  } | null;
  /** Callback when a table action is triggered */
  onTableAction?: ((action: TableAction) => void) | undefined;
};

/**
 * Props for individual toolbar buttons
 */
export type ToolbarButtonProps = {
  /** Whether the button is in active/pressed state */
  active?: boolean | undefined;
  /** Whether the button is disabled */
  disabled?: boolean | undefined;
  /** Button title/tooltip */
  title?: string | undefined;
  /** Click handler */
  onClick?: (() => void) | undefined;
  /** Button content */
  children: ReactNode;
  /** Additional CSS class name */
  className?: string | undefined;
  /** ARIA label for accessibility */
  ariaLabel?: string | undefined;
};

/**
 * Props for toolbar button groups
 */
export type ToolbarGroupProps = {
  /** Group label for accessibility */
  label?: string | undefined;
  /** Group content */
  children: ReactNode;
  /** Additional CSS class name */
  className?: string | undefined;
};

// ============================================================================
// SUBCOMPONENTS
// ============================================================================

/**
 * Individual toolbar button with shadcn styling.
 * Compact editor chrome button.
 */
export function ToolbarButton({
  active = false,
  disabled = false,
  title,
  onClick,
  children,
  className,
  ariaLabel,
}: ToolbarButtonProps) {
  const testId =
    toToolbarTestId(ariaLabel) ||
    toToolbarTestId(title, { stripParentheses: true });

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  const button = (
    <button
      type="button"
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
        "transition-colors duration-100",
        "-webkit-font-smoothing-antialiased",
        "text-[var(--doc-text-muted)] hover:bg-[var(--doc-primary-light)] hover:text-[var(--doc-text)]",
        active &&
          "bg-[var(--doc-primary-light)] text-[var(--doc-text)] hover:bg-[var(--doc-primary-light)]",
        disabled &&
          "cursor-not-allowed text-[var(--doc-text-subtle)] opacity-[0.16] disabled:hover:bg-transparent disabled:hover:text-[var(--doc-text-subtle)]",
        className,
      )}
      onMouseDown={handleMouseDown}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-pressed={active}
      aria-label={ariaLabel || title}
      data-testid={testId ? `toolbar-${testId}` : undefined}
    >
      {children}
    </button>
  );

  if (title) {
    return <Tooltip content={title}>{button}</Tooltip>;
  }

  return button;
}

function toToolbarTestId(
  value: string | undefined,
  options: { stripParentheses?: boolean } = {},
): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = options.stripParentheses
    ? stripParentheticalText(value)
    : value;
  return normalized.trim().toLowerCase().split(/\s+/u).join("-");
}

function stripParentheticalText(value: string): string {
  let result = "";
  let depth = 0;
  for (const char of value) {
    if (char === "(") {
      depth++;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) {
      result += char;
    }
  }
  return result;
}

/**
 * Toolbar button group. No built-in border; use ToolbarSeparator between groups.
 */
export function ToolbarGroup({
  label,
  children,
  className,
}: ToolbarGroupProps) {
  return (
    <div
      className={cn("flex items-center gap-0.5", className)}
      role="group"
      aria-label={label}
    >
      {children}
    </div>
  );
}

/**
 * Toolbar separator.
 */
export function ToolbarSeparator() {
  return (
    <div
      className="mx-1 h-6 w-px shrink-0 bg-[var(--doc-border)] sm:mx-2"
      role="separator"
    />
  );
}

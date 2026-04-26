/**
 * FormattingBar — clean, minimal toolbar for legal document editing.
 *
 * Controls (left to right):
 * Undo Redo | Style ▾ | B I U | A▾ 🔗 | ≡▾ 1. • ◁ ▷
 *
 * Everything else (font, size, strikethrough, highlight, comments,
 * editing mode) is accessible via keyboard shortcuts or host app chrome.
 */

import React, { useCallback, useEffect, useRef } from "react";
import type { ReactNode } from "react";

import {
  BaselineIcon,
  BoldIcon,
  ChevronDownIcon,
  ItalicIcon,
  Redo2Icon,
  UnderlineIcon,
  Undo2Icon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { ColorPicker } from "@stella/ui/components/color-picker";
import type { ColorPreset } from "@stella/ui/components/color-picker";

import type { ColorValue, ParagraphAlignment } from "../core/types/document";
import { cn } from "../lib/utils";
import {
  ToolbarButton,
  ToolbarGroup,
  ToolbarSeparator,
} from "./toolbarPrimitives";
import type { ToolbarProps, FormattingAction } from "./toolbarPrimitives";
import { AlignmentButtons } from "./ui/AlignmentButtons";
import { FontPicker } from "./ui/FontPicker";
import { ListButtons, createDefaultListState } from "./ui/ListButtons";
import { StylePicker } from "./ui/StylePicker";

const ICON_SIZE = 18;

/** Document color presets — hex values for OOXML compatibility. */
const DOCUMENT_COLOR_PRESETS: ColorPreset[] = [
  { label: "Black", value: "000000" },
  { label: "White", value: "FFFFFF" },
  { label: "Dark Red", value: "C00000" },
  { label: "Red", value: "FF0000" },
  { label: "Orange", value: "FFC000" },
  { label: "Yellow", value: "FFFF00" },
  { label: "Light Green", value: "92D050" },
  { label: "Green", value: "00B050" },
  { label: "Teal", value: "008080" },
  { label: "Light Blue", value: "00B0F0" },
  { label: "Blue", value: "0070C0" },
  { label: "Dark Blue", value: "002060" },
  { label: "Purple", value: "7030A0" },
  { label: "Dark Gray", value: "404040" },
  { label: "Medium Gray", value: "808080" },
  { label: "Light Gray", value: "C0C0C0" },
];

export type FormattingBarProps = {
  children?: ReactNode;
  /** Extra controls rendered inline in the center column (after formatting buttons) */
  inlineExtra?: ReactNode;
  inline?: boolean;
} & ToolbarProps;

export function FormattingBar(props: FormattingBarProps) {
  const {
    currentFormatting = {},
    onFormat,
    onUndo,
    onRedo,
    canUndo = false,
    canRedo = false,
    disabled = false,
    className,
    style,
    enableShortcuts = true,
    editorRef,
    children,
    showStylePicker = true,
    showFontPicker = true,
    showTextColorPicker = true,
    showAlignmentButtons = true,
    showListButtons = true,
    documentStyles,
    theme,
    onRefocusEditor,
    inlineExtra,
    inline = false,
  } = props;

  const t = useTranslations("folio");
  const barRef = useRef<HTMLDivElement>(null);

  const handleFormat = useCallback(
    (action: FormattingAction) => {
      if (!disabled && onFormat) {
        onFormat(action);
      }
    },
    [disabled, onFormat],
  );

  const handleUndo = useCallback(() => {
    if (!disabled && canUndo && onUndo) {
      onUndo();
    }
  }, [disabled, canUndo, onUndo]);

  const handleRedo = useCallback(() => {
    if (!disabled && canRedo && onRedo) {
      onRedo();
    }
  }, [disabled, canRedo, onRedo]);

  const handleFontFamilyChange = useCallback(
    (fontFamily: string) => {
      if (!disabled && onFormat) {
        onFormat({ type: "fontFamily", value: fontFamily });
        requestAnimationFrame(() => onRefocusEditor?.());
      }
    },
    [disabled, onFormat, onRefocusEditor],
  );

  const handleTextColorSelect = useCallback(
    (hex: string) => {
      if (!disabled && onFormat) {
        onFormat({ type: "textColor", value: { rgb: hex } });
        requestAnimationFrame(() => onRefocusEditor?.());
      }
    },
    [disabled, onFormat, onRefocusEditor],
  );

  const handleTextColorClear = useCallback(() => {
    if (!disabled && onFormat) {
      onFormat({ type: "textColor", value: { auto: true } as ColorValue });
      requestAnimationFrame(() => onRefocusEditor?.());
    }
  }, [disabled, onFormat, onRefocusEditor]);

  const handleAlignmentChange = useCallback(
    (alignment: ParagraphAlignment) => {
      if (!disabled && onFormat) {
        onFormat({ type: "alignment", value: alignment });
      }
    },
    [disabled, onFormat],
  );

  const handleBulletList = useCallback(() => {
    if (!disabled && onFormat) {
      onFormat("bulletList");
    }
  }, [disabled, onFormat]);

  const handleNumberedList = useCallback(() => {
    if (!disabled && onFormat) {
      onFormat("numberedList");
    }
  }, [disabled, onFormat]);

  const handleIndent = useCallback(() => {
    if (!disabled && onFormat) {
      onFormat("indent");
    }
  }, [disabled, onFormat]);

  const handleOutdent = useCallback(() => {
    if (!disabled && onFormat) {
      onFormat("outdent");
    }
  }, [disabled, onFormat]);

  const handleStyleChange = useCallback(
    (styleId: string) => {
      if (!disabled && onFormat) {
        onFormat({ type: "applyStyle", value: styleId });
        requestAnimationFrame(() => onRefocusEditor?.());
      }
    },
    [disabled, onFormat, onRefocusEditor],
  );

  // Keyboard shortcuts
  useEffect(() => {
    if (!enableShortcuts) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editorContainer = editorRef?.current;
      const barContainer = barRef.current;
      if (
        !editorContainer?.contains(target) &&
        !barContainer?.contains(target)
      ) {
        return;
      }

      const isCtrl = event.ctrlKey || event.metaKey;

      // Cmd+Enter — page break
      if (isCtrl && event.key === "Enter") {
        event.preventDefault();
        handleFormat("insertPageBreak");
        return;
      }

      // Cmd+Shift shortcuts
      if (isCtrl && event.shiftKey) {
        switch (event.key) {
          case "=":
          case "+":
            event.preventDefault();
            handleFormat("superscript");
            return;
          case "8":
            event.preventDefault();
            handleBulletList();
            return;
          default:
            break;
        }
      }

      if (!isCtrl || event.altKey) {
        return;
      }

      switch (event.key.toLowerCase()) {
        case "b":
          event.preventDefault();
          handleFormat("bold");
          break;
        case "i":
          event.preventDefault();
          handleFormat("italic");
          break;
        case "u":
          event.preventDefault();
          handleFormat("underline");
          break;
        case "k":
          event.preventDefault();
          handleFormat("insertLink");
          break;
        case "d":
          event.preventDefault();
          handleFormat("strikethrough");
          break;
        case "l":
          event.preventDefault();
          handleAlignmentChange("left");
          break;
        case "e":
          event.preventDefault();
          handleAlignmentChange("center");
          break;
        case "r":
          event.preventDefault();
          handleAlignmentChange("right");
          break;
        case "j":
          event.preventDefault();
          handleAlignmentChange("both");
          break;
        case "=":
          event.preventDefault();
          handleFormat("subscript");
          break;
        case "]":
          event.preventDefault();
          handleIndent();
          break;
        case "[":
          event.preventDefault();
          handleOutdent();
          break;
        default:
          break;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [enableShortcuts, handleFormat, handleAlignmentChange, editorRef]);

  const handleBarMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName !== "INPUT" && target.tagName !== "SELECT") {
      e.preventDefault();
    }
  }, []);

  const handleBarMouseUp = useCallback(
    () => requestAnimationFrame(() => onRefocusEditor?.()),
    [onRefocusEditor],
  );

  return (
    <div
      ref={barRef}
      className={cn(
        !inline &&
          "scrollbar-none flex h-11 items-center gap-0.5 overflow-x-auto border-b border-[var(--doc-border)] bg-[var(--doc-page)] px-4 py-1",
        className,
      )}
      style={inline ? { display: "contents", ...style } : style}
      role={inline ? "presentation" : "toolbar"}
      aria-label={inline ? undefined : t("formattingToolbar")}
      onMouseDown={inline ? undefined : handleBarMouseDown}
      onMouseUp={inline ? undefined : handleBarMouseUp}
    >
      {/* Formatting controls */}
      <div className="flex shrink-0 items-center gap-0.5">
        {/* Undo / Redo */}
        <ToolbarGroup label={t("historyGroup")}>
          <ToolbarButton
            onClick={handleUndo}
            disabled={disabled || !canUndo}
            title={t("undoShortcut")}
            ariaLabel={t("undo")}
          >
            <Undo2Icon size={ICON_SIZE} />
          </ToolbarButton>
          <ToolbarButton
            onClick={handleRedo}
            disabled={disabled || !canRedo}
            title={t("redoShortcut")}
            ariaLabel={t("redo")}
          >
            <Redo2Icon size={ICON_SIZE} />
          </ToolbarButton>
        </ToolbarGroup>

        <ToolbarSeparator />

        {/* Paragraph style gallery */}
        {showStylePicker && (
          <>
            <StylePicker
              value={currentFormatting.styleId || "Normal"}
              onChange={handleStyleChange}
              styles={documentStyles}
              theme={theme}
              disabled={disabled}
            />
            <ToolbarSeparator />
          </>
        )}

        {/* Bold, Italic, Underline */}
        <ToolbarGroup label={t("textFormattingGroup")}>
          <ToolbarButton
            onClick={() => handleFormat("bold")}
            active={currentFormatting.bold}
            disabled={disabled}
            title={t("boldShortcut")}
            ariaLabel={t("bold")}
          >
            <BoldIcon size={ICON_SIZE} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => handleFormat("italic")}
            active={currentFormatting.italic}
            disabled={disabled}
            title={t("italicShortcut")}
            ariaLabel={t("italic")}
          >
            <ItalicIcon size={ICON_SIZE} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => handleFormat("underline")}
            active={currentFormatting.underline}
            disabled={disabled}
            title={t("underlineShortcut")}
            ariaLabel={t("underline")}
          >
            <UnderlineIcon size={ICON_SIZE} />
          </ToolbarButton>
        </ToolbarGroup>

        <ToolbarSeparator />

        {/* Font picker + Text color */}
        <ToolbarGroup label={t("fontGroup")}>
          {showFontPicker && (
            <FontPicker
              value={currentFormatting.fontFamily || "Arial"}
              onChange={handleFontFamilyChange}
              disabled={disabled}
              width={100}
              placeholder="Arial"
            />
          )}
          {showTextColorPicker && (
            <ColorPicker
              presets={DOCUMENT_COLOR_PRESETS}
              columns={8}
              value={currentFormatting.color?.replace(/^#/, "").toUpperCase()}
              onSelect={handleTextColorSelect}
              onClear={handleTextColorClear}
            >
              <ToolbarButton
                disabled={disabled}
                title={t("fontColor")}
                ariaLabel={t("fontColor")}
              >
                <div className="flex flex-col items-center gap-0">
                  <BaselineIcon size={ICON_SIZE} />
                  <span
                    className="mt-[-2px] h-1 w-4 rounded-sm"
                    style={{
                      backgroundColor: currentFormatting.color
                        ? currentFormatting.color.startsWith("#")
                          ? currentFormatting.color
                          : `#${currentFormatting.color}`
                        : "#000000",
                    }}
                  />
                </div>
                <ChevronDownIcon size={10} />
              </ToolbarButton>
            </ColorPicker>
          )}
        </ToolbarGroup>

        <ToolbarSeparator />

        {/* Alignment + Lists + Indent */}
        {showAlignmentButtons && (
          <ToolbarGroup label={t("alignmentGroup")}>
            <AlignmentButtons
              value={currentFormatting.alignment || "left"}
              onChange={handleAlignmentChange}
              disabled={disabled}
            />
          </ToolbarGroup>
        )}

        {showListButtons && (
          <ToolbarGroup label={t("listsGroup")}>
            <ListButtons
              listState={
                currentFormatting.listState || createDefaultListState()
              }
              onBulletList={handleBulletList}
              onNumberedList={handleNumberedList}
              onIndent={handleIndent}
              onOutdent={handleOutdent}
              disabled={disabled}
              showIndentButtons={true}
              compact
              hasIndent={(currentFormatting.indentLeft ?? 0) > 0}
            />
          </ToolbarGroup>
        )}

        {inlineExtra}
      </div>

      {/* Host extras (track changes, etc.) */}
      <div className="ms-auto flex shrink-0 items-center gap-1">{children}</div>
    </div>
  );
}

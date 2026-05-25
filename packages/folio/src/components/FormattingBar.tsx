/**
 * FormattingBar — clean, minimal toolbar for legal document editing.
 *
 * Controls (left to right):
 * Undo Redo | Style ▾ | B I U | A▾ | ≡▾ 1. • ◁ ▷
 *
 * Everything else (font, size, strikethrough, highlight, comments,
 * editing mode) is accessible via keyboard shortcuts or host app chrome.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import {
  BaselineIcon,
  BoldIcon,
  ChevronDownIcon,
  ItalicIcon,
  MoreHorizontalIcon,
  Redo2Icon,
  UnderlineIcon,
  Undo2Icon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { ColorPicker } from "@stll/ui/components/color-picker";
import type { ColorPreset } from "@stll/ui/components/color-picker";
import { Menu, MenuPopup, MenuTrigger } from "@stll/ui/components/menu";

import type { ParagraphAlignment } from "../core/types/document";
import { cn } from "../lib/utils";
import {
  ToolbarButton,
  ToolbarGroup,
  ToolbarSeparator,
} from "./toolbarPrimitives";
import type { ToolbarProps, FormattingAction } from "./toolbarPrimitives";
import { AlignmentButtons } from "./ui/AlignmentButtons";
import { FontPicker } from "./ui/FontPicker";
import { FontSizePicker } from "./ui/FontSizePicker";
import { ListButtons, createDefaultListState } from "./ui/ListButtons";
import { StylePicker } from "./ui/StylePicker";

const ICON_SIZE = 16;
const INLINE_SECONDARY_CONTROLS_MIN_WIDTH = 760;

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
  /** Host controls that should stay in the primary row before text formatting */
  priorityExtra?: ReactNode;
  /** Extra controls rendered inline in the center column (after formatting buttons) */
  inlineExtra?: ReactNode;
  /** Display label for the style picker when the backing document is hydrating. */
  stylePickerLabel?: string | undefined;
  /** Computed preview style for the hydrating style picker label. */
  stylePickerLabelStyle?: CSSProperties | undefined;
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
    showFontSizePicker = true,
    showTextColorPicker = true,
    showAlignmentButtons = true,
    showListButtons = true,
    documentStyles,
    theme,
    onRefocusEditor,
    priorityExtra,
    inlineExtra,
    stylePickerLabel,
    stylePickerLabelStyle,
    inline = false,
  } = props;

  const t = useTranslations("folio");
  const barRef = useRef<HTMLDivElement>(null);
  const [showSecondaryInline, setShowSecondaryInline] = useState(false);

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

  const handleFontSizeChange = useCallback(
    (sizePt: number) => {
      if (!disabled && onFormat) {
        onFormat({ type: "fontSize", value: sizePt });
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
      onFormat({ type: "textColor", value: { auto: true } });
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

    const claimShortcut = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.target instanceof HTMLElement)) {
        return;
      }
      const target = event.target;
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
        claimShortcut(event);
        handleFormat("insertPageBreak");
        return;
      }

      // Cmd+Shift shortcuts
      if (isCtrl && event.shiftKey) {
        switch (event.key) {
          case "=":
          case "+":
            claimShortcut(event);
            handleFormat("superscript");
            return;
          case "8":
            claimShortcut(event);
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
          claimShortcut(event);
          handleFormat("bold");
          break;
        case "i":
          claimShortcut(event);
          handleFormat("italic");
          break;
        case "u":
          claimShortcut(event);
          handleFormat("underline");
          break;
        case "d":
          claimShortcut(event);
          handleFormat("strikethrough");
          break;
        case "l":
          claimShortcut(event);
          handleAlignmentChange("left");
          break;
        case "e":
          claimShortcut(event);
          handleAlignmentChange("center");
          break;
        case "r":
          claimShortcut(event);
          handleAlignmentChange("right");
          break;
        case "j":
          claimShortcut(event);
          handleAlignmentChange("both");
          break;
        case "=":
          claimShortcut(event);
          handleFormat("subscript");
          break;
        case "]":
          claimShortcut(event);
          handleIndent();
          break;
        case "[":
          claimShortcut(event);
          handleOutdent();
          break;
        default:
          break;
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [
    enableShortcuts,
    handleFormat,
    handleAlignmentChange,
    handleBulletList,
    handleIndent,
    handleOutdent,
    editorRef,
  ]);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar || inline) {
      setShowSecondaryInline(inline);
      return undefined;
    }

    const update = () => {
      const shouldShow =
        bar.getBoundingClientRect().width >=
        INLINE_SECONDARY_CONTROLS_MIN_WIDTH;
      setShowSecondaryInline((current) =>
        current === shouldShow ? current : shouldShow,
      );
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(bar);

    return () => {
      observer.disconnect();
    };
  }, [inline]);

  const handleBarMouseDown = useCallback((e: React.MouseEvent) => {
    if (!(e.target instanceof HTMLElement)) {
      e.preventDefault();
      return;
    }
    const target = e.target;
    if (target.tagName !== "INPUT" && target.tagName !== "SELECT") {
      e.preventDefault();
    }
  }, []);

  const handleBarMouseUp = useCallback(
    () => requestAnimationFrame(() => onRefocusEditor?.()),
    [onRefocusEditor],
  );

  const secondaryControls = (
    <>
      <ToolbarGroup label={t("fontGroup")}>
        {showFontPicker && (
          <FontPicker
            value={currentFormatting.fontFamily || "Arial"}
            onChange={handleFontFamilyChange}
            disabled={disabled}
            width={108}
            placeholder="Arial"
          />
        )}
        {showFontSizePicker && (
          <FontSizePicker
            value={
              currentFormatting.fontSize !== undefined
                ? currentFormatting.fontSize / 2
                : undefined
            }
            onChange={handleFontSizeChange}
            disabled={disabled}
            placeholder={t("fontSize")}
          />
        )}
        {showTextColorPicker && (
          <ColorPicker
            presets={DOCUMENT_COLOR_PRESETS}
            columns={8}
            value={currentFormatting.color?.replace(/^#/u, "").toUpperCase()}
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
                    backgroundColor: (() => {
                      if (currentFormatting.color) {
                        return (() => {
                          if (currentFormatting.color.startsWith("#")) {
                            return currentFormatting.color;
                          }
                          return `#${currentFormatting.color}`;
                        })();
                      }
                      return "#000000";
                    })(),
                  }}
                />
              </div>
              <ChevronDownIcon size={10} />
            </ToolbarButton>
          </ColorPicker>
        )}
      </ToolbarGroup>

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
            listState={currentFormatting.listState || createDefaultListState()}
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
    </>
  );

  return (
    <div
      ref={barRef}
      className={cn(
        !inline &&
          "flex h-12 w-full items-center gap-0.5 overflow-hidden border-b border-[var(--doc-border)] bg-[var(--doc-page)] px-2 sm:px-4",
        className,
      )}
      style={inline ? { display: "contents", ...style } : style}
      role="toolbar"
      aria-label={t("formattingToolbar")}
      tabIndex={-1}
      onMouseDown={inline ? undefined : handleBarMouseDown}
      onMouseUp={inline ? undefined : handleBarMouseUp}
    >
      {/* Formatting controls */}
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overflow-y-hidden overscroll-x-contain">
        {/* Undo / Redo */}
        <ToolbarGroup className="gap-0" label={t("historyGroup")}>
          <ToolbarButton
            className="h-8 w-7 rounded-e-none disabled:opacity-[0.35]"
            onClick={handleUndo}
            disabled={disabled || !canUndo}
            title={t("undoShortcut")}
            ariaLabel={t("undo")}
          >
            <Undo2Icon size={ICON_SIZE} />
          </ToolbarButton>
          <ToolbarButton
            className="h-8 w-7 rounded-s-none disabled:opacity-[0.35]"
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
              displayLabel={stylePickerLabel}
              displayLabelStyle={stylePickerLabelStyle}
              className="shrink-0"
              width="clamp(112px, 15vw, 140px)"
            />
            <ToolbarSeparator />
          </>
        )}

        {priorityExtra && (
          <>
            {priorityExtra}
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

        {showSecondaryInline ? (
          <>
            <ToolbarSeparator />
            {secondaryControls}
          </>
        ) : (
          <>
            <ToolbarSeparator />
            <Menu>
              <MenuTrigger
                render={
                  <button
                    type="button"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--doc-text-muted)] transition-colors duration-100 hover:bg-[var(--doc-primary-light)] hover:text-[var(--doc-text)]"
                    aria-label={t("moreFormatting")}
                    title={t("moreFormatting")}
                  />
                }
              >
                <MoreHorizontalIcon size={ICON_SIZE} />
              </MenuTrigger>
              <MenuPopup
                align="end"
                className="max-w-[min(520px,calc(100vw-24px))]"
              >
                <div className="flex w-[min(480px,calc(100vw-48px))] flex-wrap items-center gap-1 p-1">
                  {secondaryControls}
                </div>
              </MenuPopup>
            </Menu>
          </>
        )}
      </div>

      {/* Host extras (track changes, etc.) */}
      <div className="ms-auto flex shrink-0 items-center gap-1">{children}</div>
    </div>
  );
}

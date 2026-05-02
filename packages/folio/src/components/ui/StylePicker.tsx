/**
 * Style Picker — uses Stella's Select component for paragraph styles.
 *
 * Shows the current style name in a ghost-style trigger. Dropdown
 * renders each style with font preview (size/weight matching the style).
 */

import * as React from "react";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";

import type { Style, StyleType, Theme } from "../../core/types/document";

// ============================================================================
// TYPES
// ============================================================================

export type StyleOption = {
  styleId: string;
  name: string;
  type: StyleType;
  isDefault?: boolean | undefined;
  qFormat?: boolean | undefined;
  priority?: number | undefined;
  fontSize?: number | undefined;
  bold?: boolean | undefined;
  italic?: boolean | undefined;
  color?: string | undefined;
};

export type StylePickerProps = {
  value?: string | undefined;
  onChange?: ((styleId: string) => void) | undefined;
  displayLabel?: string | undefined;
  displayLabelStyle?: React.CSSProperties | undefined;
  styles?: Style[] | undefined;
  theme?: Theme | null | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
  width?: number | string | undefined;
};

// ============================================================================
// DEFAULT STYLES
// ============================================================================

const DEFAULT_STYLES: StyleOption[] = [
  {
    styleId: "Normal",
    name: "Normal",
    type: "paragraph",
    priority: 0,
    qFormat: true,
    fontSize: 22,
  },
  {
    styleId: "Heading1",
    name: "Heading 1",
    type: "paragraph",
    priority: 1,
    qFormat: true,
    fontSize: 40,
    bold: true,
  },
  {
    styleId: "Heading2",
    name: "Heading 2",
    type: "paragraph",
    priority: 2,
    qFormat: true,
    fontSize: 32,
    bold: true,
  },
  {
    styleId: "Heading3",
    name: "Heading 3",
    type: "paragraph",
    priority: 3,
    qFormat: true,
    fontSize: 28,
    bold: true,
  },
  {
    styleId: "Title",
    name: "Title",
    type: "paragraph",
    priority: 4,
    qFormat: true,
    fontSize: 52,
    bold: true,
  },
  {
    styleId: "Subtitle",
    name: "Subtitle",
    type: "paragraph",
    priority: 5,
    qFormat: true,
    fontSize: 30,
  },
];

// ============================================================================
// HELPERS
// ============================================================================

const PREVIEW_SIZES: Record<string, { fontSize: number; fontWeight: number }> =
  {
    Normal: { fontSize: 14, fontWeight: 400 },
    Heading1: { fontSize: 18, fontWeight: 700 },
    Heading2: { fontSize: 16, fontWeight: 700 },
    Heading3: { fontSize: 15, fontWeight: 600 },
    Title: { fontSize: 20, fontWeight: 700 },
    Subtitle: { fontSize: 15, fontWeight: 400 },
  };

function getItemStyle(style: StyleOption): React.CSSProperties {
  const preset = PREVIEW_SIZES[style.styleId];
  if (preset) {
    return {
      fontSize: preset.fontSize,
      fontWeight: preset.fontWeight,
      fontStyle: style.italic ? "italic" : undefined,
    };
  }
  const pt = style.fontSize ? style.fontSize / 2 : 11;
  return {
    fontSize: Math.min(Math.max(pt * 0.8, 12), 18),
    fontWeight: style.bold ? 600 : 400,
    fontStyle: style.italic ? "italic" : undefined,
  };
}

// ============================================================================
// COMPONENT
// ============================================================================

export function StylePicker({
  value,
  onChange,
  displayLabel,
  displayLabelStyle,
  styles,
  disabled = false,
  className,
  width = 140,
}: StylePickerProps) {
  const styleOptions = React.useMemo(() => {
    if (!styles || styles.length === 0) {
      return DEFAULT_STYLES;
    }
    const docStyles = styles
      .filter((s) => s.type === "paragraph")
      .filter((s) => s.qFormat || (!s.hidden && !s.semiHidden))
      .map((s) => {
        const def = DEFAULT_STYLES.find((d) => d.styleId === s.styleId);
        return {
          styleId: s.styleId,
          name: s.name || s.styleId,
          type: s.type,
          isDefault: s.default,
          qFormat: s.qFormat,
          priority: s.uiPriority ?? 99,
          fontSize: s.rPr?.fontSize ?? def?.fontSize,
          bold: s.rPr?.bold ?? def?.bold,
          italic: s.rPr?.italic ?? def?.italic,
          color: s.rPr?.color?.rgb ?? def?.color,
        };
      });
    return docStyles.toSorted(
      (a, b) => (a.priority ?? 99) - (b.priority ?? 99),
    );
  }, [styles]);

  return (
    <Select
      value={value || "Normal"}
      onValueChange={(val) => onChange?.(val ?? "")}
      disabled={disabled}
    >
      <SelectTrigger
        size="sm"
        className={`h-8 min-h-0 min-w-0 border-transparent bg-transparent text-sm text-[var(--doc-text-muted)] shadow-none hover:bg-[var(--doc-primary-light)] hover:text-[var(--doc-text)] data-[pressed]:bg-[var(--doc-primary-light)] ${className ?? ""}`}
        data-folio-style-picker=""
        style={{
          width: typeof width === "number" ? `${width}px` : width,
        }}
      >
        {displayLabel !== undefined ? (
          <span
            className="data-placeholder:text-muted-foreground flex flex-1 items-center gap-2 truncate"
            data-slot="select-value"
            style={displayLabelStyle}
          >
            {displayLabel}
          </span>
        ) : (
          <SelectValue />
        )}
      </SelectTrigger>
      <SelectPopup>
        {styleOptions.map((style) => (
          <SelectItem key={style.styleId} value={style.styleId}>
            <span style={getItemStyle(style)}>{style.name}</span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * Font Picker — uses Stella's Select component.
 * Each item rendered in its own font for preview.
 */

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";

// ============================================================================
// TYPES
// ============================================================================

export type FontOption = {
  name: string;
  fontFamily: string;
  category?: "sans-serif" | "serif" | "monospace" | "other";
};

export type FontPickerProps = {
  value?: string;
  onChange?: (fontFamily: string) => void;
  fonts?: FontOption[];
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  width?: number | string;
  showPreview?: boolean;
};

// ============================================================================
// DEFAULT FONTS
// ============================================================================

const DEFAULT_FONTS: FontOption[] = [
  {
    name: "Arial",
    fontFamily: "Arial, Helvetica, sans-serif",
    category: "sans-serif",
  },
  {
    name: "Calibri",
    fontFamily: '"Calibri", Arial, sans-serif',
    category: "sans-serif",
  },
  {
    name: "Helvetica",
    fontFamily: "Helvetica, Arial, sans-serif",
    category: "sans-serif",
  },
  {
    name: "Verdana",
    fontFamily: "Verdana, Geneva, sans-serif",
    category: "sans-serif",
  },
  {
    name: "Open Sans",
    fontFamily: '"Open Sans", sans-serif',
    category: "sans-serif",
  },
  { name: "Roboto", fontFamily: "Roboto, sans-serif", category: "sans-serif" },
  {
    name: "Times New Roman",
    fontFamily: '"Times New Roman", Times, serif',
    category: "serif",
  },
  { name: "Georgia", fontFamily: "Georgia, serif", category: "serif" },
  { name: "Cambria", fontFamily: "Cambria, Georgia, serif", category: "serif" },
  { name: "Garamond", fontFamily: "Garamond, serif", category: "serif" },
  {
    name: "Courier New",
    fontFamily: '"Courier New", Courier, monospace',
    category: "monospace",
  },
  {
    name: "Consolas",
    fontFamily: "Consolas, monospace",
    category: "monospace",
  },
];

// ============================================================================
// COMPONENT
// ============================================================================

/** Normalize a fontFamily CSS value to a display name */
function toDisplayName(fontFamily: string, fonts: FontOption[]): string {
  const match = fonts.find(
    (f) =>
      f.fontFamily === fontFamily ||
      f.name.toLowerCase() === fontFamily.toLowerCase(),
  );
  if (match) {
    return match.name;
  }
  // Extract first font name from CSS value
  // SAFETY: split always returns at least one element
  return (fontFamily.split(",")[0] ?? "").replace(/['"]/g, "").trim();
}

export function FontPicker({
  value,
  onChange,
  fonts,
  disabled = false,
  placeholder = "Font",
  width = 100,
}: FontPickerProps) {
  const fontOptions = fonts ?? DEFAULT_FONTS;

  return (
    <Select
      value={value ? toDisplayName(value, fontOptions) : undefined}
      onValueChange={(name) => {
        const font = fontOptions.find((f) => f.name === name);
        if (font) {
          onChange?.(font.name);
        }
      }}
      disabled={disabled}
    >
      <SelectTrigger
        size="sm"
        className="min-h-0 min-w-0 border-transparent bg-transparent text-sm text-[var(--doc-text-muted)] shadow-none hover:bg-[var(--doc-primary-light)] hover:text-[var(--doc-text)] data-[pressed]:bg-[var(--doc-primary-light)]"
        style={{
          width: typeof width === "number" ? `${width}px` : width,
          height: 28,
        }}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectPopup>
        {fontOptions.map((font) => (
          <SelectItem key={font.name} value={font.name}>
            <span style={{ fontFamily: font.fontFamily }}>{font.name}</span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

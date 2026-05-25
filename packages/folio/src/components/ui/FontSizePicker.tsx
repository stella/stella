/**
 * Font Size Picker — uses Stella's Select component.
 * Values are points; internally the editor stores half-points (OOXML w:sz).
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

export type FontSizePickerProps = {
  /** Current size in points. */
  value?: number | undefined;
  /** Called with the new size in points. */
  onChange?: ((sizePt: number) => void) | undefined;
  /** Override the default size list. Values in points. */
  sizes?: number[] | undefined;
  disabled?: boolean | undefined;
  placeholder?: string | undefined;
  width?: number | string | undefined;
};

// Word's standard size ladder, in points.
const DEFAULT_SIZES = [
  8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72,
] as const;

const NUMERIC_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  useGrouping: false,
});

function formatSize(pt: number): string {
  return NUMERIC_FORMATTER.format(pt);
}

export function FontSizePicker({
  value,
  onChange,
  sizes,
  disabled = false,
  placeholder = "",
  width = 56,
}: FontSizePickerProps) {
  const sizeOptions = sizes ?? Array.from(DEFAULT_SIZES);
  const selectedLabel = value === undefined ? undefined : formatSize(value);

  return (
    <Select
      value={selectedLabel}
      onValueChange={(label) => {
        if (typeof label !== "string") {
          return;
        }
        const parsed = Number.parseFloat(label);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return;
        }
        onChange?.(parsed);
      }}
      disabled={disabled}
    >
      <SelectTrigger
        size="sm"
        className="min-h-0 min-w-0 border-transparent bg-transparent text-sm text-[var(--doc-text-muted)] tabular-nums shadow-none hover:bg-[var(--doc-primary-light)] hover:text-[var(--doc-text)] data-[pressed]:bg-[var(--doc-primary-light)]"
        style={{
          width: typeof width === "number" ? `${width}px` : width,
          height: 28,
        }}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectPopup>
        {sizeOptions.map((size) => {
          const label = formatSize(size);
          return (
            <SelectItem key={label} value={label}>
              {label}
            </SelectItem>
          );
        })}
      </SelectPopup>
    </Select>
  );
}

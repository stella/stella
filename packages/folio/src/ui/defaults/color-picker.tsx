import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { cn } from "../../lib/utils";
import type { ColorPreset, FolioColorPickerProps } from "../folio-ui";

/**
 * Built-in, dependency-light ColorPicker used when a consumer does not inject
 * one. Wraps `@base-ui/react`'s Popover primitive (focus management,
 * portalling, collision-aware positioning) and renders the `presets` as a row
 * of swatch buttons plus a native `<input type="color">` for a custom color.
 * `onSelect` emits a preset value or a 6-char uppercase hex (no `#`), matching
 * the design-system ColorPicker contract. Consumers inject a polished picker
 * via `DocxEditor`'s `components` prop.
 */
const swatchColor = (preset: ColorPreset): string =>
  preset.color ?? `#${preset.value}`;

const normalizeHex = (hex: string): string =>
  hex.replace(/^#/u, "").toUpperCase();

const EMPTY_PRESETS: ColorPreset[] = [];

export function DefaultColorPicker({
  value,
  onSelect,
  onClear,
  presets = EMPTY_PRESETS,
  columns = 8,
  children,
}: FolioColorPickerProps) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
        nativeButton={false}
        render={<div className="folio-default-color-picker-trigger" />}
      >
        {children}
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          align="start"
          className="folio-default-popover-positioner"
          side="bottom"
          sideOffset={4}
        >
          <PopoverPrimitive.Popup className="folio-default-color-picker-popup">
            {onClear && (
              <PopoverPrimitive.Close
                className="folio-default-color-picker-clear"
                onClick={onClear}
              >
                No color
              </PopoverPrimitive.Close>
            )}
            <div
              className="folio-default-color-picker-swatches"
              style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
            >
              {presets.map((preset) => (
                <PopoverPrimitive.Close
                  aria-label={preset.label}
                  className={cn(
                    "folio-default-color-picker-swatch",
                    value === preset.value &&
                      "folio-default-color-picker-swatch--selected",
                  )}
                  key={preset.value}
                  onClick={() => onSelect?.(preset.value)}
                  style={{ backgroundColor: swatchColor(preset) }}
                  title={preset.label}
                />
              ))}
            </div>
            <label className="folio-default-color-picker-custom">
              Custom
              <input
                aria-label="Custom color"
                onChange={(event) =>
                  onSelect?.(normalizeHex(event.target.value))
                }
                type="color"
                value={value ? `#${normalizeHex(value)}` : "#000000"}
              />
            </label>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

"use client";

import { Suspense, lazy, useState } from "react";
import type * as React from "react";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { CheckIcon, ChevronDownIcon } from "lucide-react";

import { cn } from "@stll/ui/lib/utils";

const HexColorPicker = lazy(async () => {
  const m = await import("@stll/ui/components/hex-color-picker");
  return { default: m.HexColorPicker };
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ColorPreset = {
  label: string;
  /** Value emitted on select (e.g. "red" or "FF0000") */
  value: string;
  /** CSS color for the swatch (e.g. "var(--option-red)" or "#FF0000").
   *  Falls back to `#${value}` when omitted. */
  color?: string;
};

type ColorPickerProps = {
  /** Currently selected value (matches a preset value, or a hex without #) */
  value?: string | undefined;
  /** Called with the preset value on selection, or a hex string from the input */
  onSelect?: (value: string) => void;
  /** Show "No Color" button; fires on click */
  onClear?: () => void;
  /** Color presets. Falls back to DEFAULT_PRESETS when omitted. */
  presets?: ColorPreset[];
  /** Grid columns (default 9) */
  columns?: number;
  /** Start with hex input visible (default false) */
  defaultExpanded?: boolean;
  /** Popover trigger element */
  children: React.ReactNode;
  /** Popover placement side */
  side?: "top" | "bottom" | "left" | "right";
  /** Popover placement alignment */
  align?: "start" | "center" | "end";
  className?: string;
};

type ColorPickerContentProps = {
  value?: string | undefined;
  onSelect?: ((value: string) => void) | undefined;
  onClear?: (() => void) | undefined;
  presets: ColorPreset[];
  columns: number;
  defaultExpanded: boolean;
};

// ---------------------------------------------------------------------------
// Default presets — 18 curated colors using semantic CSS variables
// ---------------------------------------------------------------------------

const DEFAULT_PRESETS: ColorPreset[] = [
  { label: "Black", value: "000000", color: "#000000" },
  { label: "White", value: "FFFFFF", color: "#FFFFFF" },
  { label: "Red", value: "red", color: "var(--option-red)" },
  { label: "Orange", value: "orange", color: "var(--option-orange)" },
  { label: "Amber", value: "amber", color: "var(--option-amber)" },
  { label: "Yellow", value: "yellow", color: "var(--option-yellow)" },
  { label: "Lime", value: "lime", color: "var(--option-lime)" },
  { label: "Green", value: "green", color: "var(--option-green)" },
  { label: "Emerald", value: "emerald", color: "var(--option-emerald)" },
  { label: "Teal", value: "teal", color: "var(--option-teal)" },
  { label: "Cyan", value: "cyan", color: "var(--option-cyan)" },
  { label: "Sky", value: "sky", color: "var(--option-sky)" },
  { label: "Blue", value: "blue", color: "var(--option-blue)" },
  { label: "Indigo", value: "indigo", color: "var(--option-indigo)" },
  { label: "Violet", value: "violet", color: "var(--option-violet)" },
  { label: "Purple", value: "purple", color: "var(--option-purple)" },
  { label: "Fuchsia", value: "fuchsia", color: "var(--option-fuchsia)" },
  { label: "Gray", value: "gray", color: "var(--option-gray)" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isValidHex = (hex: string) => /^[0-9A-Fa-f]{6}$/u.test(hex);

const normalizeHex = (hex: string) => hex.replace(/^#/u, "").toUpperCase();

/** CSS color to render for a preset swatch. */
const swatchColor = (preset: ColorPreset) => preset.color ?? `#${preset.value}`;

/** Returns true when a 6-char hex is light enough to need a visible border. */
const isLightHex = (hex: string): boolean => {
  if (hex.length !== 6) {
    return false;
  }
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 220;
};

/** Check if a value looks like a 6-char hex (no CSS vars, no named colors). */
const looksLikeHex = (v: string) => /^[0-9A-Fa-f]{6}$/u.test(v);

// ---------------------------------------------------------------------------
// ColorSwatch (internal)
// ---------------------------------------------------------------------------

function ColorSwatch({
  cssColor,
  selected,
  label,
  isLight,
  onClick,
}: {
  cssColor: string;
  selected: boolean;
  label: string;
  isLight: boolean;
  onClick: () => void;
}) {
  return (
    <PopoverPrimitive.Close
      render={
        <button
          aria-label={label}
          className={cn(
            "hover:border-foreground relative flex size-6 items-center justify-center rounded-md border transition-[transform,border-color] hover:scale-115 sm:size-5",
            selected
              ? "border-foreground ring-ring/24 ring-1"
              : "border-border/40",
            isLight && !selected && "border-border",
          )}
          onClick={onClick}
          style={{ backgroundColor: cssColor }}
          title={label}
          type="button"
        />
      }
    >
      {selected && (
        <CheckIcon
          className="pointer-events-none size-3 sm:size-2.5"
          style={{ color: isLight ? "#000" : "#fff" }}
        />
      )}
    </PopoverPrimitive.Close>
  );
}

// ---------------------------------------------------------------------------
// ColorPickerContent (public — for embedding without popover)
// ---------------------------------------------------------------------------

function ColorPickerContent({
  value,
  onSelect,
  onClear,
  presets,
  columns,
  defaultExpanded,
}: ColorPickerContentProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  // pickerHex: last valid 6-char hex from the visual picker (drives the picker's color prop)
  // inputHex: raw text in the hex input (may be partial, e.g. "FF")
  const [pickerHex, setPickerHex] = useState(
    () => (looksLikeHex(value ?? "") ? value : "000000") ?? "000000",
  );
  const [inputHex, setInputHex] = useState("");

  /** Called when the visual picker (SB square / hue strip) emits a color. */
  const handlePickerChange = (hex: string) => {
    const normalized = normalizeHex(hex);
    setPickerHex(normalized);
    setInputHex(normalized);
    if (isValidHex(normalized)) {
      onSelect?.(normalized);
    }
  };

  /** Called when the hex text input changes. */
  const handleInputChange = (raw: string) => {
    const cleaned = raw
      .replace(/[^0-9A-Fa-f]/gu, "")
      .slice(0, 6)
      .toUpperCase();
    setInputHex(cleaned);
    if (isValidHex(cleaned)) {
      setPickerHex(cleaned);
      onSelect?.(cleaned);
    }
  };

  return (
    <div className="flex flex-col gap-1.5" data-slot="color-picker">
      {/* No Color — full-width text button */}
      {onClear && (
        <PopoverPrimitive.Close
          render={
            <button
              aria-label="No color"
              className="text-muted-foreground hover:bg-accent hover:text-accent-foreground flex h-6 w-full items-center gap-1.5 rounded px-1 text-[11px] transition-colors"
              onClick={onClear}
              type="button"
            />
          }
        >
          <span className="bg-popover border-border relative flex size-4 items-center justify-center rounded-sm border">
            <span className="bg-destructive absolute h-px w-[140%] rotate-[-45deg]" />
          </span>
          No Color
        </PopoverPrimitive.Close>
      )}

      {/* Preset grid */}
      <div
        className="grid gap-0.5"
        role="grid"
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        }}
      >
        {presets.map((preset) => (
          <ColorSwatch
            key={preset.value}
            cssColor={swatchColor(preset)}
            isLight={looksLikeHex(preset.value) && isLightHex(preset.value)}
            label={preset.label}
            onClick={() => onSelect?.(preset.value)}
            selected={value === preset.value}
          />
        ))}
      </div>

      {/* Expand / custom color */}
      {!expanded ? (
        <button
          className="text-muted-foreground hover:text-foreground flex items-center justify-center gap-1 py-0.5 text-[11px] transition-colors"
          onClick={() => setExpanded(true)}
          type="button"
        >
          More
          <ChevronDownIcon className="size-3" />
        </button>
      ) : (
        <div className="border-border flex flex-col gap-2 border-t pt-2">
          <Suspense
            fallback={
              <div
                aria-hidden
                className="ring-border/30 h-[140px] w-full rounded-lg ring-1"
              />
            }
          >
            <HexColorPicker
              className="ring-border/30 !h-[140px] !w-full overflow-hidden rounded-lg ring-1"
              color={pickerHex}
              onChange={(hex) => handlePickerChange(hex.replace("#", ""))}
            />
          </Suspense>
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground text-[11px]">#</span>
            <input
              aria-label="Custom hex color"
              className="border-input bg-background text-foreground h-6 flex-1 rounded border px-1.5 font-mono text-[11px] outline-none"
              maxLength={6}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              placeholder="FF0000"
              value={inputHex}
            />
            {isValidHex(inputHex) && (
              <span
                className="border-border size-6 shrink-0 rounded border"
                style={{ backgroundColor: `#${inputHex}` }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ColorPicker (public)
// ---------------------------------------------------------------------------

function ColorPicker({
  value,
  onSelect,
  onClear,
  presets = DEFAULT_PRESETS,
  columns = 9,
  defaultExpanded = false,
  children,
  side = "bottom",
  align = "start",
  className,
}: ColorPickerProps) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
        data-slot="color-picker-trigger"
        nativeButton={false}
        render={<div className="inline-flex" />}
      >
        {children}
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          align={align}
          className="z-50"
          side={side}
          sideOffset={4}
        >
          <PopoverPrimitive.Popup
            className={cn(
              "bg-popover text-popover-foreground origin-(--transform-origin) rounded-lg border p-2 shadow-lg/5 transition-[scale,opacity] not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-starting-style:scale-98 data-starting-style:opacity-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
              className,
            )}
            data-slot="color-picker-popup"
          >
            <ColorPickerContent
              columns={columns}
              defaultExpanded={defaultExpanded}
              onClear={onClear}
              onSelect={onSelect}
              presets={presets}
              value={value}
            />
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export {
  ColorPicker,
  ColorPickerContent,
  DEFAULT_PRESETS,
  type ColorPickerContentProps,
  type ColorPickerProps,
  type ColorPreset,
};

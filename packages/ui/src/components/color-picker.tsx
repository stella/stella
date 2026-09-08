"use client";

import { Suspense, lazy, useState } from "react";
import type * as React from "react";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { CheckIcon, ChevronDownIcon } from "lucide-react";

import { OVERLAY_LAYER_CLASS_NAMES } from "../lib/overlay-layer";
import { cn } from "../lib/utils";

const HexColorPicker = lazy(async () => {
  const m = await import("./hex-color-picker");
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
  /** Localized label for expanding the custom color controls. */
  moreLabel: string;
  /** Popover trigger element */
  children: React.ReactNode;
  /** Popover placement side */
  side?: "top" | "bottom" | "left" | "right";
  /** Popover placement alignment */
  align?: "start" | "center" | "end";
  className?: string;
};

type ColorPickerContentBaseProps = {
  value?: string | undefined;
  onSelect?: ((value: string) => void) | undefined;
  presets: ColorPreset[];
  moreLabel: string;
};

type ColorPickerContentProps = ColorPickerContentBaseProps &
  (
    | {
        columns: number;
        defaultExpanded: boolean;
        onClear?: (() => void) | undefined;
        /** Popover content closes on preset selection. */
        presentation?: "popover";
      }
    | {
        columns?: never;
        defaultExpanded?: never;
        onClear?: never;
        /** Inline content stays mounted and reserves its popup for custom color. */
        presentation: "inline";
      }
  );

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

const checkIconColorClassNames = {
  dark: "text-(--color-white)",
  light: "text-(--color-black)",
} as const;

/** Check if a value looks like a 6-char hex (no CSS vars, no named colors). */
const looksLikeHex = (v: string) => /^[0-9A-Fa-f]{6}$/u.test(v);

// ---------------------------------------------------------------------------
// ColorSwatch (internal)
// ---------------------------------------------------------------------------

const ColorSwatch = ({
  cssColor,
  selected,
  label,
  isLight,
  onClick,
  presentation,
}: {
  cssColor: string;
  selected: boolean;
  label: string;
  isLight: boolean;
  onClick: () => void;
  presentation: "inline" | "popover";
}) => {
  let selectionClassName = "border-border/40";
  if (selected) {
    selectionClassName =
      presentation === "inline"
        ? "border-transparent ring-2 ring-ring"
        : "border-foreground ring-ring/24 ring-1";
  }
  const swatch = (
    <button
      aria-label={label}
      aria-pressed={selected}
      className={cn(
        presentation === "inline"
          ? "ring-offset-popover relative grid size-11 shrink-0 place-items-center rounded-full border ring-offset-2 transition-transform outline-none hover:scale-105 focus-visible:ring-2"
          : "hover:border-foreground relative flex size-6 items-center justify-center rounded-md border transition-[transform,border-color] hover:scale-115 sm:size-5",
        selectionClassName,
        isLight && !selected && "border-border",
      )}
      onClick={onClick}
      style={{ backgroundColor: cssColor }}
      type="button"
    >
      {selected && (
        <CheckIcon
          className={cn(
            "pointer-events-none",
            presentation === "inline"
              ? "bg-background/88 text-foreground size-5 rounded-full p-0.5 shadow-sm"
              : "size-3 sm:size-2.5",
            presentation === "popover" &&
              checkIconColorClassNames[isLight ? "light" : "dark"],
          )}
        />
      )}
    </button>
  );

  return presentation === "inline" ? (
    swatch
  ) : (
    <PopoverPrimitive.Close render={swatch} />
  );
};

type CustomColorControlsProps = {
  handleInputChange: (raw: string) => void;
  handlePickerChange: (hex: string) => void;
  inputHex: string;
  pickerHex: string;
};

const CustomColorControls = ({
  handleInputChange,
  handlePickerChange,
  inputHex,
  pickerHex,
}: CustomColorControlsProps) => (
  <>
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
        dir="ltr"
        maxLength={6}
        onChange={(event) => handleInputChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") {
            event.stopPropagation();
          }
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
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
  </>
);

type InlineCustomColorProps = {
  customSelected: boolean;
  handleInputChange: (raw: string) => void;
  handlePickerChange: (hex: string) => void;
  inputHex: string;
  label: string;
  pickerHex: string;
  presets: ColorPreset[];
  value: string | undefined;
};

const InlineCustomColor = ({
  customSelected,
  handleInputChange,
  handlePickerChange,
  inputHex,
  label,
  pickerHex,
  presets,
  value,
}: InlineCustomColorProps) => {
  const customColor = customSelected ? `#${value}` : undefined;
  const customGradient = `conic-gradient(${presets
    .map((preset) => swatchColor(preset))
    .join(", ")})`;

  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
        render={
          <button
            aria-label={label}
            aria-pressed={customSelected}
            className={cn(
              "ring-offset-popover relative grid size-11 shrink-0 place-items-center rounded-full border border-transparent ring-offset-2 transition-transform outline-none hover:scale-105 focus-visible:ring-2",
              customSelected && "ring-ring ring-2",
            )}
            style={
              customColor
                ? { backgroundColor: customColor }
                : { backgroundImage: customGradient }
            }
            type="button"
          />
        }
      >
        {customSelected ? (
          <CheckIcon className="bg-background/88 text-foreground pointer-events-none size-5 rounded-full p-0.5 shadow-sm" />
        ) : null}
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          align="end"
          className={OVERLAY_LAYER_CLASS_NAMES.popup}
          side="bottom"
          sideOffset={4}
        >
          <PopoverPrimitive.Popup
            className="bg-popover text-popover-foreground flex w-56 flex-col gap-2 rounded-lg border p-2 shadow-lg/5"
            data-slot="color-picker-custom-popup"
          >
            <CustomColorControls
              handleInputChange={handleInputChange}
              handlePickerChange={handlePickerChange}
              inputHex={inputHex}
              pickerHex={pickerHex}
            />
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
};

// ---------------------------------------------------------------------------
// ColorPickerContent (public — for embedding without popover)
// ---------------------------------------------------------------------------

const ColorPickerContent = ({
  value,
  onSelect,
  onClear,
  presets,
  columns,
  defaultExpanded,
  moreLabel,
  presentation = "popover",
}: ColorPickerContentProps) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  // pickerHex: last valid 6-char hex from the visual picker (drives the picker's color prop)
  // inputHex: raw text in the hex input (may be partial, e.g. "FF")
  const [pickerHex, setPickerHex] = useState(
    () => (looksLikeHex(value ?? "") ? value : "000000") ?? "000000",
  );
  const [inputHex, setInputHex] = useState("");
  const presetSelected = presets.some((preset) => preset.value === value);
  const customSelected = !presetSelected && looksLikeHex(value ?? "");

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

  if (presentation === "inline") {
    return (
      <div className="flex items-center gap-1" data-slot="color-picker">
        {presets.map((preset) => (
          <ColorSwatch
            key={preset.value}
            cssColor={swatchColor(preset)}
            isLight={looksLikeHex(preset.value) && isLightHex(preset.value)}
            label={preset.label}
            onClick={() => onSelect?.(preset.value)}
            presentation="inline"
            selected={value === preset.value}
          />
        ))}
        <InlineCustomColor
          customSelected={customSelected}
          handleInputChange={handleInputChange}
          handlePickerChange={handlePickerChange}
          inputHex={inputHex}
          label={moreLabel}
          pickerHex={pickerHex}
          presets={presets}
          value={value}
        />
      </div>
    );
  }

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
            presentation="popover"
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
          {moreLabel}
          <ChevronDownIcon className="size-3" />
        </button>
      ) : (
        <div className="border-border flex flex-col gap-2 border-t pt-2">
          <CustomColorControls
            handleInputChange={handleInputChange}
            handlePickerChange={handlePickerChange}
            inputHex={inputHex}
            pickerHex={pickerHex}
          />
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// ColorPicker (public)
// ---------------------------------------------------------------------------

const ColorPicker = ({
  value,
  onSelect,
  onClear,
  presets = DEFAULT_PRESETS,
  columns = 9,
  defaultExpanded = false,
  moreLabel,
  children,
  side = "bottom",
  align = "start",
  className,
}: ColorPickerProps) => (
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
        className={OVERLAY_LAYER_CLASS_NAMES.popup}
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
            moreLabel={moreLabel}
            onClear={onClear}
            onSelect={onSelect}
            presentation="popover"
            presets={presets}
            value={value}
          />
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  </PopoverPrimitive.Root>
);

export {
  ColorPicker,
  ColorPickerContent,
  DEFAULT_PRESETS,
  type ColorPickerContentProps,
  type ColorPickerProps,
  type ColorPreset,
};

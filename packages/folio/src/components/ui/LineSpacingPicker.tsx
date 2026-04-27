/**
 * Line Spacing Picker Component
 *
 * A dropdown selector for choosing line spacing values using Stella Select.
 * Styled like Google Docs with options: Single, 1.15, 1.5, Double
 */

import * as React from "react";

import { AlignVerticalSpaceBetweenIcon } from "lucide-react";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectGroup,
  SelectGroupLabel,
  SelectTrigger,
} from "@stella/ui/components/select";

import { cn } from "../../lib/utils";

// ============================================================================
// TYPES
// ============================================================================

export type LineSpacingOption = {
  label: string;
  value: number;
  twipsValue: number;
};

export type LineSpacingPickerProps = {
  value?: number;
  onChange?: (twipsValue: number) => void;
  options?: LineSpacingOption[];
  disabled?: boolean;
  className?: string;
  width?: number | string;
};

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Standard line spacing options (Google Docs style)
 * OOXML uses twips for line spacing when lineRule="auto"
 * 240 twips = 1.0 line spacing (single)
 */
const DEFAULT_OPTIONS: LineSpacingOption[] = [
  { label: "Single", value: 1, twipsValue: 240 },
  { label: "1.15", value: 1.15, twipsValue: 276 },
  { label: "1.5", value: 1.5, twipsValue: 360 },
  { label: "Double", value: 2, twipsValue: 480 },
];

// ============================================================================
// COMPONENT
// ============================================================================

export function LineSpacingPicker({
  value,
  onChange,
  options = DEFAULT_OPTIONS,
  disabled = false,
  className,
}: LineSpacingPickerProps) {
  // Find current option by twips value
  // SAFETY: options always contains at least DEFAULT_OPTIONS entries
  const currentOption = React.useMemo(() => {
    if (value === undefined) {
      return options[0]!;
    } // Default to Single
    return options.find((opt) => opt.twipsValue === value) ?? options[0]!;
  }, [value, options]);

  const handleValueChange = React.useCallback(
    (newValue: string | null) => {
      if (!newValue) {
        return;
      }
      const twips = Number.parseInt(newValue, 10);
      if (!Number.isNaN(twips)) {
        onChange?.(twips);
      }
    },
    [onChange],
  );

  return (
    <Select
      value={currentOption.twipsValue.toString()}
      onValueChange={handleValueChange}
      disabled={disabled}
    >
      <SelectTrigger
        size="sm"
        className={cn(
          "min-h-0 min-w-0 border-transparent bg-transparent text-sm text-[var(--doc-text-muted)] shadow-none hover:bg-[var(--doc-primary-light)] hover:text-[var(--doc-text)] data-[pressed]:bg-[var(--doc-primary-light)]",
          className,
        )}
        style={{ width: "auto", height: 32 }}
        title={`Line spacing: ${currentOption.label}`}
      >
        <AlignVerticalSpaceBetweenIcon className="h-5 w-5 shrink-0" />
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem
            key={option.twipsValue}
            value={option.twipsValue.toString()}
          >
            {option.label}
          </SelectItem>
        ))}
        <SelectSeparator />
        <SelectGroup>
          <SelectGroupLabel>Paragraph spacing</SelectGroupLabel>
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

export function getDefaultLineSpacingOptions(): LineSpacingOption[] {
  return [...DEFAULT_OPTIONS];
}

export function lineSpacingMultiplierToTwips(multiplier: number): number {
  return Math.round(multiplier * 240);
}

export function twipsToLineSpacingMultiplier(twips: number): number {
  return twips / 240;
}

export function getLineSpacingLabel(twips: number): string {
  const option = DEFAULT_OPTIONS.find((opt) => opt.twipsValue === twips);
  if (option) {
    return option.label;
  }
  const multiplier = twipsToLineSpacingMultiplier(twips);
  return String(Number(multiplier.toFixed(2)));
}

export function isStandardLineSpacing(twips: number): boolean {
  return DEFAULT_OPTIONS.some((opt) => opt.twipsValue === twips);
}

export function nearestStandardLineSpacing(twips: number): LineSpacingOption {
  // SAFETY: DEFAULT_OPTIONS is a non-empty constant array
  let nearest = DEFAULT_OPTIONS[0]!;
  let minDiff = Math.abs(twips - nearest.twipsValue);

  for (const option of DEFAULT_OPTIONS) {
    const diff = Math.abs(twips - option.twipsValue);
    if (diff < minDiff) {
      minDiff = diff;
      nearest = option;
    }
  }

  return nearest;
}

export function createLineSpacingOption(multiplier: number): LineSpacingOption {
  const twipsValue = lineSpacingMultiplierToTwips(multiplier);
  const label = String(Number(multiplier.toFixed(2)));
  return { label, value: multiplier, twipsValue };
}

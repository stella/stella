/**
 * Zoom Control Component
 *
 * A dropdown for controlling document zoom level using Stella Select.
 */

import * as React from "react";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stella/ui/components/select";

import { cn } from "../../lib/utils";

// ============================================================================
// TYPES
// ============================================================================

export type ZoomLevel = {
  value: number;
  label: string;
};

export type ZoomControlProps = {
  value?: number;
  onChange?: (zoom: number) => void;
  levels?: ZoomLevel[];
  disabled?: boolean;
  className?: string;
  minZoom?: number;
  maxZoom?: number;
  showButtons?: boolean;
  persistZoom?: boolean;
  storageKey?: string;
  compact?: boolean;
};

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_ZOOM_LEVELS: ZoomLevel[] = [
  { value: 0.5, label: "50%" },
  { value: 0.75, label: "75%" },
  { value: 1, label: "100%" },
  { value: 1.25, label: "125%" },
  { value: 1.5, label: "150%" },
  { value: 2, label: "200%" },
];

// ============================================================================
// COMPONENT
// ============================================================================

export function ZoomControl({
  value = 1,
  onChange,
  levels = DEFAULT_ZOOM_LEVELS,
  disabled = false,
  className,
  compact = false,
}: ZoomControlProps) {
  const displayLabel = React.useMemo(() => {
    const matchingLevel = levels.find(
      (level) => Math.abs(level.value - value) < 0.001,
    );
    if (matchingLevel) {
      return matchingLevel.label;
    }
    return `${Math.round(value * 100)}%`;
  }, [levels, value]);

  const handleValueChange = React.useCallback(
    (newValue: string | null) => {
      if (!newValue) {
        return;
      }
      const zoom = Number.parseFloat(newValue);
      if (!Number.isNaN(zoom)) {
        onChange?.(zoom);
      }
    },
    [onChange],
  );

  return (
    <Select
      value={value.toString()}
      onValueChange={handleValueChange}
      disabled={disabled}
    >
      <SelectTrigger
        size="sm"
        className={cn(
          "min-h-0 min-w-0 border-transparent bg-transparent text-[var(--doc-text-muted)] shadow-none hover:bg-[var(--doc-primary-light)] hover:text-[var(--doc-text)] data-[pressed]:bg-[var(--doc-primary-light)]",
          compact ? "text-xs" : "text-sm",
          className,
        )}
        style={{ width: compact ? 55 : 70, height: compact ? 28 : 32 }}
        aria-label={`Zoom: ${displayLabel}`}
      >
        <SelectValue placeholder="100%">{displayLabel}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {levels.map((level) => (
          <SelectItem key={level.value} value={level.value.toString()}>
            {level.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

// Re-export types for compatibility
export type { ZoomControlProps as ZoomControlPropsType };

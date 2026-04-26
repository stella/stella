/**
 * Alignment dropdown — shows current alignment icon, opens a popover
 * with left/center/right/justify options.
 */

import type { CSSProperties } from "react";

import {
  AlignCenterIcon,
  AlignJustifyIcon,
  AlignLeftIcon,
  AlignRightIcon,
  ChevronDownIcon,
} from "lucide-react";

import {
  Popover,
  PopoverClose,
  PopoverPopup,
  PopoverTrigger,
} from "@stella/ui/components/popover";

import type { ParagraphAlignment } from "../../core/types/document";
import { cn } from "../../lib/utils";

export type AlignmentButtonsProps = {
  value?: ParagraphAlignment;
  onChange?: (alignment: ParagraphAlignment) => void;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
};

const ICON_SIZE = 18;

const OPTIONS = [
  {
    value: "left" as const,
    label: "Align Left",
    shortcut: "Ctrl+L",
    Icon: AlignLeftIcon,
  },
  {
    value: "center" as const,
    label: "Center",
    shortcut: "Ctrl+E",
    Icon: AlignCenterIcon,
  },
  {
    value: "right" as const,
    label: "Align Right",
    shortcut: "Ctrl+R",
    Icon: AlignRightIcon,
  },
  {
    value: "both" as const,
    label: "Justify",
    shortcut: "Ctrl+J",
    Icon: AlignJustifyIcon,
  },
];

export function AlignmentButtons({
  value = "left",
  onChange,
  disabled = false,
}: AlignmentButtonsProps) {
  const defaultOption = OPTIONS[0];
  if (!defaultOption) {
    throw new Error("AlignmentButtons: OPTIONS is empty");
  }
  const current = OPTIONS.find((o) => o.value === value) ?? defaultOption;

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-md transition-colors",
          "text-[var(--doc-text-muted)] hover:bg-[var(--doc-primary-light)] hover:text-[var(--doc-text)]",
          disabled && "cursor-not-allowed opacity-30",
        )}
        data-testid="toolbar-alignment"
        disabled={disabled}
      >
        <current.Icon size={ICON_SIZE} />
        <ChevronDownIcon size={12} className="-ms-0.5" />
      </PopoverTrigger>
      <PopoverPopup
        side="bottom"
        sideOffset={4}
        className="flex gap-0.5 p-1"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {OPTIONS.map((opt) => (
          <PopoverClose
            key={opt.value}
            render={
              <button
                className={cn(
                  "flex size-8 items-center justify-center rounded transition-colors",
                  value === opt.value
                    ? "bg-[var(--doc-primary-light)] text-[var(--doc-primary)]"
                    : "text-[var(--doc-text)] hover:bg-[var(--doc-primary-light)]",
                )}
                data-testid={`alignment-${opt.value}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onChange?.(opt.value)}
                title={`${opt.label} (${opt.shortcut})`}
                type="button"
              />
            }
          >
            <opt.Icon size={ICON_SIZE} />
          </PopoverClose>
        ))}
      </PopoverPopup>
    </Popover>
  );
}

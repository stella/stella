"use client";

import { useRef } from "react";
import type { PropsWithChildren } from "react";

import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";

import { cn } from "../lib/utils";

const Separator = ({
  className,
  orientation = "horizontal",
  ...props
}: SeparatorPrimitive.Props) => (
  <SeparatorPrimitive
    className={cn(
      "bg-border shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:not-[[class^='h-']]:not-[[class*='_h-']]:self-stretch",
      className,
    )}
    data-slot="separator"
    orientation={orientation}
    {...props}
  />
);

type TextSeparatorProps = PropsWithChildren<{
  /** Container overrides, e.g. gap or vertical padding. */
  className?: string;
  /** Label overrides, e.g. casing or size. */
  labelClassName?: string;
}>;

/** Horizontal rule with a centered label — the "or sign in with email" /
 *  "or build a new one" divider that frames an either/or choice. The label
 *  names the alternative; flanking hairlines split the two options. */
const TextSeparator = ({
  children,
  className,
  labelClassName,
}: TextSeparatorProps) => (
  <div className={cn("flex items-center gap-3", className)}>
    <span className="bg-border h-px flex-1" />
    <span className={cn("text-muted-foreground text-xs", labelClassName)}>
      {children}
    </span>
    <span className="bg-border h-px flex-1" />
  </div>
);

type ResizeSeparatorProps = {
  className?: string;
  /** Names what the separator resizes, e.g. "Resize filters". */
  label: string;
  /** The current width (px) of the column the separator resizes. */
  value: number;
  min: number;
  max: number;
  /** How far (px) one arrow key moves the separator. */
  keyboardStep: number;
  /**
   * Receives a viewport x: the pointer's while dragging, and for an arrow key
   * the separator's own centre moved one step in the pressed physical
   * direction, so a drag and a key press feed the caller the same clamped
   * resize path.
   */
  onResize: (clientX: number) => void;
};

/**
 * The drag strip between two columns, operable without a pointer: a
 * focusable vertical `separator` carrying the width it controls. A 4px grab
 * zone straddles the adjacent column border through negative margins, so it
 * adds no visible width of its own.
 */
const ResizeSeparator = ({
  className,
  label,
  value,
  min,
  max,
  keyboardStep,
  onResize,
}: ResizeSeparatorProps) => {
  const isDraggingRef = useRef(false);

  return (
    <div
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemax={max}
      aria-valuemin={min}
      aria-valuenow={Math.round(value)}
      className={cn(
        "hover:bg-border active:bg-border focus-visible:bg-border focus-visible:ring-ring z-10 -mx-0.5 w-1 shrink-0 cursor-col-resize focus-visible:ring-1 focus-visible:outline-none",
        className,
      )}
      data-slot="resize-separator"
      onKeyDown={(event) => {
        let step: number;
        switch (event.key) {
          case "ArrowLeft":
            step = -keyboardStep;
            break;
          case "ArrowRight":
            step = keyboardStep;
            break;
          default:
            return;
        }
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        onResize(rect.left + rect.width / 2 + step);
      }}
      onPointerCancel={() => {
        isDraggingRef.current = false;
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        isDraggingRef.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (isDraggingRef.current) {
          onResize(event.clientX);
        }
      }}
      onPointerUp={() => {
        isDraggingRef.current = false;
      }}
      role="separator"
      tabIndex={0}
    />
  );
};

export { ResizeSeparator, Separator, TextSeparator };

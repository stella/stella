"use client";

import { useRef } from "react";
import type * as React from "react";

import { Field as FieldPrimitive } from "@base-ui/react/field";

import { cn } from "../lib/utils";

/** An editor whose visible text is supplied by a matching highlighted layer. */
const HighlightedTextarea = ({
  className,
  id,
  name,
  disabled,
  value,
  dir,
  highlightedContent,
  onScroll,
  ...props
}: HighlightedTextareaProps) => {
  const backdropRef = useRef<HTMLDivElement>(null);
  const syncScroll: NonNullable<HighlightedTextareaProps["onScroll"]> = (
    event,
  ) => {
    if (backdropRef.current) {
      backdropRef.current.scrollTop = event.currentTarget.scrollTop;
      backdropRef.current.scrollLeft = event.currentTarget.scrollLeft;
    }
    onScroll?.(event);
  };

  return (
    <div
      className={cn("relative min-h-0", className)}
      data-slot="highlighted-textarea"
      dir={dir}
    >
      <div
        aria-hidden="true"
        className={cn(
          TEXT_LAYER_CLASS,
          "text-foreground pointer-events-none absolute inset-0 overflow-hidden",
        )}
        data-slot="highlighted-textarea-backdrop"
        ref={backdropRef}
      >
        {highlightedContent}
        {value.endsWith("\n") ? "\u200b" : null}
      </div>
      <FieldPrimitive.Control
        id={id}
        name={name}
        disabled={disabled}
        value={value}
        render={
          <textarea
            className={cn(
              TEXT_LAYER_CLASS,
              "caret-foreground ring-ring absolute inset-0 border-0 bg-transparent text-transparent outline-none [-webkit-text-fill-color:transparent] focus-visible:ring-2 focus-visible:ring-inset",
            )}
            data-slot="highlighted-textarea-editor"
            dir={dir}
            {...props}
            defaultValue={undefined}
            style={undefined}
            wrap={undefined}
            onScroll={syncScroll}
          >
            {null}
          </textarea>
        }
      />
    </div>
  );
};

// Both layers must use exactly the same text metrics and wrapping. Direction
// is inherited together from the wrapper, never inferred for just one layer.
const TEXT_LAYER_CLASS =
  "m-0 h-full w-full resize-none scrollbar-stable p-4 font-sans text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]";

type HighlightedTextareaProps = Omit<
  React.ComponentProps<"textarea">,
  "children" | "className" | "defaultValue" | "dir" | "style" | "value" | "wrap"
> & {
  /** Layout of the enclosing editor; text presentation belongs to both layers. */
  className?: string;
  /** Omit to inherit the surrounding direction for both layers. */
  dir?: "ltr" | "rtl";
  /** The same text as value, with optional inline highlighting. */
  highlightedContent: React.ReactNode;
  value: string;
};

export { HighlightedTextarea, type HighlightedTextareaProps };

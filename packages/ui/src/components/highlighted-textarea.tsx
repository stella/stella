"use client";

import { useRef } from "react";
import type * as React from "react";

import { Field as FieldPrimitive } from "@base-ui/react/field";
import { mergeProps } from "@base-ui/react/merge-props";

import { cn } from "../lib/utils";

/** An editor whose visible text is supplied by a matching highlighted layer. */
const HighlightedTextarea = ({
  className,
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
      </div>
      <FieldPrimitive.Control
        render={(defaultProps) => (
          <textarea
            className={cn(
              TEXT_LAYER_CLASS,
              "caret-foreground absolute inset-0 border-0 bg-transparent text-transparent outline-none [-webkit-text-fill-color:transparent]",
            )}
            data-slot="highlighted-textarea-editor"
            dir={dir}
            {...mergeProps(defaultProps, props, { onScroll: syncScroll })}
          />
        )}
      />
    </div>
  );
};

// Both layers must use exactly the same text metrics and wrapping. Direction
// is inherited together from the wrapper, never inferred for just one layer.
const TEXT_LAYER_CLASS =
  "m-0 h-full w-full resize-none p-4 font-sans text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]";

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

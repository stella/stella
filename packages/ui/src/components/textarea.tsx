"use client";

import { useState } from "react";
import type * as React from "react";

import { Field as FieldPrimitive } from "@base-ui/react/field";
import { mergeProps } from "@base-ui/react/merge-props";

import { useContentDir } from "../hooks/use-content-dir";
import { CONTROL_SIZE } from "../lib/control-size";
import type { ControlSize } from "../lib/control-size";
import { cn } from "../lib/utils";
import { INLINE_FIELD_CLASS_NAME } from "./input-control";

type TextareaProps = React.ComponentProps<"textarea"> & {
  size?: ControlSize | number;
  unstyled?: boolean;
  /**
   * A borderless field in a line of text: it edits text where it is read
   * (the summary under a heading), with no box until focused, the parent's
   * type and colour, no floor height, and grows with its content. See
   * `INLINE_FIELD_CLASS_NAME`.
   */
  inline?: boolean;
  /**
   * `content` (default) grows with what is typed. `fixed` keeps the height
   * its `rows` give and scrolls, with no resize grip: an editor inside a
   * table cell or a row must not push its neighbours around.
   */
  fieldSizing?: "content" | "fixed";
  /**
   * The most lines it grows to before it scrolls. Without it the field grows
   * with its content without end.
   */
  maxRows?: number | undefined;
  /**
   * Shows `length / maxLength` under the end of the field. Needs `maxLength`;
   * the browser still enforces the limit.
   */
  showCount?: boolean | undefined;
};

const Textarea = ({
  className,
  size = CONTROL_SIZE.default,
  unstyled = false,
  inline = false,
  fieldSizing = "content",
  maxRows,
  showCount = false,
  dir,
  onChange,
  style,
  ...props
}: TextareaProps) => {
  const controlSize = typeof size === "number" ? CONTROL_SIZE.default : size;
  const contentDir = useContentDir({
    dir,
    value: props.value,
    defaultValue: props.defaultValue,
  });
  const [typedLength, setTypedLength] = useState(() =>
    textLength(props.defaultValue),
  );
  const length =
    props.value === undefined ? typedLength : textLength(props.value);
  const counted = showCount && props.maxLength !== undefined;
  const handleChange: NonNullable<TextareaProps["onChange"]> = (event) => {
    contentDir.trackValue(event.currentTarget.value);
    if (counted) {
      setTypedLength(event.currentTarget.value.length);
    }
    onChange?.(event);
  };
  return (
    <span
      className={
        cn(
          inline && "relative inline-flex w-full",
          !unstyled &&
            !inline &&
            "border-input bg-background text-foreground ring-ring/24 has-focus-visible:border-ring has-aria-invalid:border-destructive/36 has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 dark:bg-input/32 dark:has-aria-invalid:ring-destructive/24 relative inline-flex w-full rounded-lg border text-base shadow-xs/5 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-disabled:has-not-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] has-focus-visible:ring-[3px] has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none sm:text-sm dark:not-has-disabled:has-not-focus-visible:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)]",
          className,
        ) || undefined
      }
      data-size={size}
      data-slot="textarea-control"
    >
      <FieldPrimitive.Control
        render={(defaultProps) => (
          <textarea
            className={cn(
              inline
                ? cn(INLINE_FIELD_CLASS_NAME, "resize-none")
                : cn(
                    "min-h-17.5 w-full rounded-[inherit] px-[calc(--spacing(3)-1px)] py-[calc(--spacing(1.5)-1px)] outline-none max-sm:min-h-20.5",
                    TEXTAREA_SIZE_CLASS_NAMES[controlSize],
                  ),
              fieldSizing === "content"
                ? "field-sizing-content"
                : "field-sizing-fixed resize-none",
              // One line is `1lh`; the block padding is added on top so the
              // last allowed line is not cut.
              maxRows !== undefined &&
                "max-h-[calc(var(--textarea-max-rows)*1lh+--spacing(3))]",
              counted && "pb-6",
            )}
            data-slot="textarea"
            {...mergeProps(defaultProps, props, { onChange: handleChange })}
            dir={contentDir.dir}
            style={
              maxRows === undefined
                ? style
                : ({
                    ...style,
                    "--textarea-max-rows": maxRows,
                  } as React.CSSProperties)
            }
          />
        )}
      />
      {counted ? (
        <span
          aria-hidden="true"
          className="text-muted-foreground pointer-events-none absolute end-3 bottom-1.5 text-xs tabular-nums"
          data-slot="textarea-count"
        >
          {length}/{props.maxLength}
        </span>
      ) : null}
    </span>
  );
};

const TEXTAREA_SIZE_CLASS_NAMES = {
  [CONTROL_SIZE.sm]:
    "min-h-16.5 px-[calc(--spacing(2.5)-1px)] py-[calc(--spacing(1)-1px)] max-sm:min-h-19.5",
  [CONTROL_SIZE.default]: undefined,
  [CONTROL_SIZE.lg]: "min-h-18.5 py-[calc(--spacing(2)-1px)] max-sm:min-h-21.5",
} as const satisfies Record<ControlSize, string | undefined>;

function textLength(value: TextareaProps["value"]): number {
  if (value === undefined || value === null) {
    return 0;
  }
  return String(value).length;
}

export { Textarea, type TextareaProps };

"use client";

import { useState } from "react";
import type * as React from "react";

import { Field as FieldPrimitive } from "@base-ui/react/field";

import { useExternalSyncEffect, useLatestCallback } from "../effects/effects";
import { useContentDir } from "../hooks/use-content-dir";
import { CONTROL_SIZE } from "../lib/control-size";
import type { ControlSize } from "../lib/control-size";
import { cn } from "../lib/utils";
import { COMPOSER_TEXT_CLASS } from "./composer-tokens";
import { INLINE_FIELD_CLASS_NAME } from "./input-control";

/**
 * React's `CSSProperties` has no key for a custom property, so the one the
 * row cap sets is named on a local style type.
 */
type TextareaStyle = React.CSSProperties & {
  "--textarea-max-rows"?: number;
};

type TextareaProps = React.ComponentProps<"textarea"> & {
  size?: ControlSize | number;
  /**
   * A borderless editor for the `text` slot of a `ComposerFrame`: it grows
   * with what is typed, and the frame sets its height floor, caps it and
   * scrolls it.
   */
  appearance?: "default" | "composer";
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
  id,
  name,
  disabled,
  value,
  defaultValue,
  size = CONTROL_SIZE.default,
  appearance = "default",
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
  const composer = appearance === "composer";
  const fieldEditorClass = inline
    ? cn(
        INLINE_FIELD_CLASS_NAME,
        "resize-none [--textarea-pb:0px] [--textarea-pt:0px]",
      )
    : cn(
        "w-full rounded-[inherit] px-[calc(--spacing(3)-1px)] outline-none",
        TEXTAREA_SIZE_CLASS_NAMES[controlSize],
        fieldSizing === "content" && TEXTAREA_FLOOR_CLASS_NAMES[controlSize],
      );
  const editorClass = composer
    ? cn(
        "placeholder:text-foreground-placeholder block w-full resize-none bg-transparent outline-none [--textarea-pb:0px] [--textarea-pt:0px]",
        COMPOSER_TEXT_CLASS,
      )
    : fieldEditorClass;
  const contentDir = useContentDir({
    dir,
    value,
    defaultValue,
  });
  const [typedLength, setTypedLength] = useState(() =>
    textLength(defaultValue),
  );
  const length = value === undefined ? typedLength : textLength(value);
  const counted = showCount && props.maxLength !== undefined;
  const handleChange: NonNullable<TextareaProps["onChange"]> = (event) => {
    contentDir.trackValue(event.currentTarget.value);
    if (counted) {
      setTypedLength(event.currentTarget.value.length);
    }
    onChange?.(event);
  };
  // A native form reset restores the text without an input or change event,
  // so an uncontrolled count rereads the field once the reset has run.
  const [control, setControl] = useState<HTMLSpanElement | null>(null);
  const countsUncontrolled = counted && value === undefined;
  const trackValue = useLatestCallback(contentDir.trackValue);
  useExternalSyncEffect(() => {
    const textarea = control?.querySelector("textarea");
    const form = textarea?.form;
    if (!countsUncontrolled || !textarea || !form) {
      return undefined;
    }
    const handleReset = () => {
      // `reset` is dispatched before the form restores its fields.
      setTimeout(() => {
        trackValue(textarea.value);
        setTypedLength(textarea.value.length);
      }, 0);
    };
    form.addEventListener("reset", handleReset);
    return () => {
      form.removeEventListener("reset", handleReset);
    };
  }, [control, countsUncontrolled, trackValue]);
  const textareaStyle: TextareaStyle | undefined =
    maxRows === undefined
      ? style
      : { ...style, "--textarea-max-rows": maxRows };
  return (
    <span
      className={
        cn(
          composer && "block w-full",
          !composer && inline && "relative inline-flex w-full",
          // The count is placed against the field, styled or not.
          counted && "relative",
          !composer &&
            !unstyled &&
            !inline &&
            "border-input bg-background text-foreground ring-ring/24 has-focus-visible:border-ring has-aria-invalid:border-destructive/36 has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 dark:bg-input/32 dark:has-aria-invalid:ring-destructive/24 relative inline-flex w-full rounded-lg border text-base shadow-xs/5 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-disabled:has-not-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] has-focus-visible:ring-[3px] has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none sm:text-sm dark:not-has-disabled:has-not-focus-visible:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)]",
          className,
        ) || undefined
      }
      data-appearance={appearance}
      data-size={size}
      data-slot="textarea-control"
      ref={setControl}
    >
      <FieldPrimitive.Control
        id={id}
        name={name}
        disabled={disabled}
        value={value}
        defaultValue={defaultValue}
        render={
          <textarea
            className={cn(
              editorClass,
              fieldSizing === "content"
                ? "field-sizing-content"
                : "field-sizing-fixed resize-none",
              // The block padding is set once, as variables, and both the
              // padding and the row cap read them, so they cannot drift.
              "pt-(--textarea-pt) pb-(--textarea-pb)",
              // The count sits in the bottom padding.
              counted && "[--textarea-pb:--spacing(6)]",
              // One line is `1lh`; the field's own block padding is added on
              // top so the last allowed line is not cut. The floor height
              // gives way, as `min-height` would otherwise win over a
              // smaller cap.
              maxRows !== undefined &&
                "max-h-[calc(var(--textarea-max-rows)*1lh+var(--textarea-pt)+var(--textarea-pb))] min-h-0 max-sm:min-h-0",
            )}
            data-slot="textarea"
            {...props}
            onChange={handleChange}
            dir={contentDir.dir}
            style={textareaStyle}
          />
        }
      />
      {counted ? (
        // Readable by assistive technology, so the current count is not
        // a sighted-only fact.
        <span
          className="text-muted-foreground pointer-events-none absolute end-3 bottom-1.5 text-xs tabular-nums"
          data-slot="textarea-count"
        >
          {length}/{props.maxLength}
        </span>
      ) : null}
    </span>
  );
};

/** Each size's block padding, as the variables the padding and cap read. */
const TEXTAREA_SIZE_CLASS_NAMES = {
  [CONTROL_SIZE.sm]:
    "px-[calc(--spacing(2.5)-1px)] [--textarea-pb:calc(--spacing(1)-1px)] [--textarea-pt:calc(--spacing(1)-1px)]",
  [CONTROL_SIZE.default]:
    "[--textarea-pb:calc(--spacing(1.5)-1px)] [--textarea-pt:calc(--spacing(1.5)-1px)]",
  [CONTROL_SIZE.lg]:
    "[--textarea-pb:calc(--spacing(2)-1px)] [--textarea-pt:calc(--spacing(2)-1px)]",
} as const satisfies Record<ControlSize, string>;

const TEXTAREA_FLOOR_CLASS_NAMES = {
  [CONTROL_SIZE.sm]: "min-h-16.5 max-sm:min-h-19.5",
  [CONTROL_SIZE.default]: "min-h-17.5 max-sm:min-h-20.5",
  [CONTROL_SIZE.lg]: "min-h-18.5 max-sm:min-h-21.5",
} as const satisfies Record<ControlSize, string>;

function textLength(value: TextareaProps["value"]): number {
  if (value === undefined) {
    return 0;
  }
  return String(value).length;
}

export { Textarea, type TextareaProps };

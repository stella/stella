import type { ComponentProps } from "react";
import { useCallback, useImperativeHandle, useRef } from "react";

import { panic } from "better-result";

import { contentDir, isStructuredInputType } from "../hooks/use-content-dir";
import { cn } from "../lib/utils";

type InlineRenameInputProps = Omit<
  ComponentProps<"input">,
  "value" | "onChange" | "onKeyDown" | "size"
> & {
  value: string;
  onValueChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  /** Fill the parent's row instead of sizing to the text. */
  fill?: boolean;
};

/** Content-sized rename field; the title's parent owns its typography. */
// An empty field keeps its placeholder's width, so it stays visible and
// clickable where the mirror does the sizing.
const mirrorTextFor = (value: string, placeholder: string | undefined) => {
  if (value !== "") {
    return value;
  }
  if (placeholder !== undefined && placeholder !== "") {
    return placeholder;
  }
  return "\u200b";
};

export const InlineRenameInput = ({
  value,
  onValueChange,
  onCommit,
  onCancel,
  onBlur,
  className,
  ref,
  dir,
  fill = false,
  ...props
}: InlineRenameInputProps) => {
  // The value the editor last finished at (Enter, Escape or a committed
  // blur). A later blur commits again only if the value moved since, whether
  // the user typed or the parent supplied a corrected draft.
  const finishedValue = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useImperativeHandle(ref, () => {
    if (!inputRef.current) {
      panic("Inline rename input must be mounted before exposing its ref");
    }
    return inputRef.current;
  }, []);
  const focusInput = useCallback((input: HTMLInputElement | null) => {
    inputRef.current = input;
    if (!input) {
      return;
    }
    input.focus();
    input.select();
  }, []);

  const mirrorText = mirrorTextFor(value, props.placeholder);

  return (
    <span
      className={cn(className)}
      data-fill={fill ? "" : undefined}
      data-slot="inline-rename"
    >
      {/* The mirror sizes older webviews without measuring or changing fonts. */}
      <span aria-hidden="true" data-slot="inline-rename-mirror">
        {mirrorText}
      </span>
      <input
        {...props}
        data-slot="inline-rename-input"
        dir={
          dir ?? (isStructuredInputType(props.type) ? "ltr" : contentDir(value))
        }
        size={undefined}
        onBlur={(event) => {
          if (finishedValue.current === value) {
            event.stopPropagation();
            return;
          }
          if (onBlur) {
            onBlur(event);
            return;
          }
          finishedValue.current = value;
          onCommit();
        }}
        onChange={(event) => {
          finishedValue.current = null;
          onValueChange(event.currentTarget.value);
        }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing) {
            return;
          }
          if (event.key !== "Enter" && event.key !== "Escape") {
            return;
          }
          event.preventDefault();
          finishedValue.current = value;
          if (event.key === "Escape") {
            onCancel();
            return;
          }
          onCommit();
        }}
        ref={focusInput}
        value={value}
      />
    </span>
  );
};

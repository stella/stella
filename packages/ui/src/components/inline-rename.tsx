import type { ComponentProps } from "react";
import { useCallback, useImperativeHandle, useRef } from "react";

import { panic } from "better-result";

import { contentDir, isStructuredInputType } from "../hooks/use-content-dir";
import { cn } from "../lib/utils";
import "../styles/inline-rename.css";

type InlineRenameInputProps = Omit<
  ComponentProps<"input">,
  "value" | "onChange" | "onKeyDown" | "size"
> & {
  value: string;
  onValueChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
};

/** Content-sized rename field; the title's parent owns its typography. */
export const InlineRenameInput = ({
  value,
  onValueChange,
  onCommit,
  onCancel,
  onBlur,
  className,
  ref,
  dir,
  ...props
}: InlineRenameInputProps) => {
  const finished = useRef(false);
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

  return (
    <span className={cn(className)} data-slot="inline-rename">
      {/* The mirror sizes older webviews without measuring or changing fonts. */}
      <span aria-hidden="true" data-slot="inline-rename-mirror">
        {value || "\u200b"}
      </span>
      <input
        {...props}
        data-slot="inline-rename-input"
        dir={
          dir ?? (isStructuredInputType(props.type) ? "ltr" : contentDir(value))
        }
        size={undefined}
        onBlur={(event) => {
          if (finished.current) {
            event.stopPropagation();
            return;
          }
          if (onBlur) {
            onBlur(event);
            return;
          }
          finished.current = true;
          onCommit();
        }}
        onChange={(event) => {
          finished.current = false;
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
          finished.current = true;
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

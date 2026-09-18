"use client";

import { useId, useRef } from "react";
import type * as React from "react";

import { UploadIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { Button } from "./button";

type FileInputProps = Omit<
  React.ComponentProps<"input">,
  "type" | "value" | "onChange" | "multiple" | "className"
> & {
  className?: string;
  file: File | null;
  onFileChange: (file: File | null) => void;
  chooseLabel: string;
  emptyLabel: string;
};

// A native `<input type="file">` paints the browser's own "Choose file" chrome,
// which no locale can translate. The real input stays for the file dialog; a
// `Button` carries the caller's translated label. The visible field label goes
// through `aria-labelledby` (a wrapping `<label>` would bind to the hidden
// input, which assistive technology skips) and is composed with the trigger's
// own text so the name reads "<field> <chooseLabel>".
const FileInput = ({
  className,
  disabled,
  file,
  onFileChange,
  chooseLabel,
  emptyLabel,
  "aria-labelledby": labelledBy,
  ...props
}: FileInputProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerId = useId();

  return (
    <span
      className={cn("flex min-w-0 items-center gap-3", className)}
      data-slot="file-input"
    >
      <input
        aria-hidden="true"
        className="sr-only"
        disabled={disabled}
        ref={inputRef}
        tabIndex={-1}
        {...props}
        multiple={false}
        onChange={(event) => {
          const next = event.currentTarget.files?.item(0) ?? null;
          // Clearing lets the same file be picked again after a reset.
          event.currentTarget.value = "";
          onFileChange(next);
        }}
        type="file"
        value={undefined}
      />
      <Button
        aria-labelledby={labelledBy ? `${labelledBy} ${triggerId}` : undefined}
        data-slot="file-input-trigger"
        disabled={disabled}
        id={triggerId}
        onClick={() => inputRef.current?.click()}
        type="button"
        variant="outline"
      >
        <UploadIcon aria-hidden="true" />
        {chooseLabel}
      </Button>
      <span
        className="text-muted-foreground min-w-0 truncate text-sm"
        data-slot="file-input-name"
      >
        {file ? <bdi>{file.name}</bdi> : emptyLabel}
      </span>
    </span>
  );
};

export { FileInput, type FileInputProps };

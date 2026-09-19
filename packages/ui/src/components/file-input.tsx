"use client";

import { useId } from "react";

import { UploadIcon } from "lucide-react";

import { openFilePicker } from "../lib/file-picker";
import { cn } from "../lib/utils";
import { Button } from "./button";

type FileInputProps = {
  accept?: string | undefined;
  "aria-labelledby"?: string | undefined;
  className?: string | undefined;
  disabled?: boolean | undefined;
  file: File | null;
  onFileChange: (file: File) => void;
  chooseLabel: string;
  emptyLabel: string;
};

// A native `<input type="file">` paints the browser's own "Choose file" chrome,
// which no locale can translate; this field opens the chooser from a `Button`
// that carries the caller's label. The visible field label goes through
// `aria-labelledby` and is composed with the trigger's own text so the name
// reads "<field> <chooseLabel>".
const FileInput = ({
  accept,
  "aria-labelledby": labelledBy,
  className,
  disabled,
  file,
  onFileChange,
  chooseLabel,
  emptyLabel,
}: FileInputProps) => {
  const triggerId = useId();

  return (
    <span
      className={cn("flex min-w-0 items-center gap-3", className)}
      data-slot="file-input"
    >
      <Button
        aria-labelledby={labelledBy ? `${labelledBy} ${triggerId}` : undefined}
        data-slot="file-input-trigger"
        disabled={disabled}
        id={triggerId}
        onClick={() =>
          openFilePicker({
            accept,
            onPick: ([first]) => onFileChange(first),
          })
        }
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

"use client";

import type * as React from "react";

import { Input as InputPrimitive } from "@base-ui/react/input";
import { SearchIcon } from "lucide-react";

import { isStructuredInputType, useContentDir } from "../hooks/use-content-dir";
import { CONTROL_SIZE } from "../lib/control-size";
import type { ControlSize } from "../lib/control-size";
import { cn } from "../lib/utils";
import {
  INPUT_CONTROL_CLASS_NAME,
  INPUT_ELEMENT_CLASS_NAME,
  INPUT_SIZE_CLASS_NAMES,
} from "./input-control";

type InputProps = Omit<
  InputPrimitive.Props & React.RefAttributes<HTMLInputElement>,
  "size" | "style"
> & {
  size?: ControlSize | number;
  style?: React.CSSProperties;
  unstyled?: boolean;
  nativeInput?: boolean;
};

const Input = ({
  className,
  size = CONTROL_SIZE.default,
  unstyled = false,
  nativeInput = false,
  dir,
  onChange,
  ...props
}: InputProps) => {
  const controlSize = typeof size === "number" ? CONTROL_SIZE.default : size;
  const contentDir = useContentDir({
    // Structured/neutral-value types (token, URL, number, date…) stay LTR
    // unless the caller forces a direction; only free-text resolves by content.
    dir: dir ?? (isStructuredInputType(props.type) ? "ltr" : undefined),
    value: props.value,
    defaultValue: props.defaultValue,
  });
  // Typed as the Base UI handler so the merged handler stays assignable to
  // both the native <input> (via React's handler bivariance) and InputPrimitive.
  const handleChange: NonNullable<InputProps["onChange"]> = (event) => {
    contentDir.trackValue(event.currentTarget.value);
    onChange?.(event);
  };
  const inputClassName = cn(
    INPUT_ELEMENT_CLASS_NAME,
    INPUT_SIZE_CLASS_NAMES[controlSize],
    props.type === "search" &&
      "ps-8 [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none [&::-webkit-search-results-button]:appearance-none [&::-webkit-search-results-decoration]:appearance-none",
    props.type === "file" &&
      "text-muted-foreground file:text-foreground file:me-3 file:bg-transparent file:text-sm file:font-medium",
  );

  return (
    <span
      className={
        cn(!unstyled && INPUT_CONTROL_CLASS_NAME, className) || undefined
      }
      data-size={size}
      data-slot="input-control"
      dir={contentDir.dir}
    >
      {props.type === "search" && (
        <SearchIcon
          aria-hidden="true"
          className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 z-1 size-3.5 -translate-y-1/2"
          data-slot="input-search-icon"
        />
      )}
      {nativeInput ? (
        <input
          className={inputClassName}
          data-slot="input"
          size={typeof size === "number" ? size : undefined}
          {...props}
          dir={contentDir.dir}
          onChange={handleChange}
        />
      ) : (
        <InputPrimitive
          className={inputClassName}
          data-slot="input"
          size={typeof size === "number" ? size : undefined}
          {...props}
          dir={contentDir.dir}
          onChange={handleChange}
        />
      )}
    </span>
  );
};

export { Input, type InputProps };

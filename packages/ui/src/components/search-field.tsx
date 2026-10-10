"use client";

import type * as React from "react";

import { XIcon } from "../icons";
import { cn } from "../lib/utils";
import { Button } from "./button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./input-group";

type SearchFieldProps = Omit<
  React.ComponentProps<typeof InputGroupInput>,
  "onChange" | "type" | "value"
> & {
  value: string;
  onValueChange: (value: string) => void;
  /** Accessible name of the clear button; the package ships no copy. */
  clearLabel: string;
  /** Class for the outer group (width, margins). */
  groupClassName?: string;
};

/**
 * Filter-as-you-type search box: leading magnifier, clear button once there is
 * a query, and Escape clears before it blurs. The caller owns the query state
 * and the matching; keep matching local and instant for lists under a few
 * hundred rows.
 */
const SearchField = ({
  value,
  onValueChange,
  clearLabel,
  groupClassName,
  className,
  onKeyDown,
  ...props
}: SearchFieldProps) => (
  <InputGroup className={cn("min-h-11 sm:min-h-0", groupClassName)}>
    <InputGroupInput
      autoComplete="off"
      spellCheck={false}
      {...props}
      className={cn("max-sm:h-11 max-sm:leading-11", className)}
      onChange={(event) => {
        onValueChange(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && value.length > 0) {
          event.preventDefault();
          event.stopPropagation();
          onValueChange("");
        }
        onKeyDown?.(event);
      }}
      type="search"
      value={value}
    />
    {value.length > 0 && (
      <InputGroupAddon align="inline-end">
        <Button
          aria-label={clearLabel}
          onClick={() => {
            onValueChange("");
          }}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </InputGroupAddon>
    )}
  </InputGroup>
);

export { SearchField };
export type { SearchFieldProps };

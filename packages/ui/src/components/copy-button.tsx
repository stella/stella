"use client";

import { useRef, useState } from "react";
import type { ComponentProps } from "react";

import { CheckIcon, CopyIcon } from "../icons";
import { cn } from "../lib/utils";
import { Button } from "./button";

const COPIED_RESET_MS = 1500;

const SWAP_CLASS =
  "col-start-1 row-start-1 transition-[opacity,scale] duration-200 ease-out motion-reduce:transition-none";

type CopyButtonProps = Omit<
  ComponentProps<typeof Button>,
  "children" | "onClick"
> & {
  /** Copies and reports whether it worked; failures stay with the caller. */
  onCopy: () => Promise<boolean>;
  label: string;
  copiedLabel: string;
  /** Renders the glyph alone, with the labels as its accessible name. */
  iconOnly?: boolean;
  iconClassName?: string;
};

/**
 * A copy action that confirms in place: the glyph turns into a check and the
 * label into `copiedLabel`, then both return. The confirmation lands where
 * the user is looking, so callers raise no success toast.
 */
export const CopyButton = ({
  onCopy,
  label,
  copiedLabel,
  iconOnly = false,
  iconClassName = "size-3.5",
  className,
  ...buttonProps
}: CopyButtonProps) => {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleClick = async () => {
    if (!(await onCopy())) {
      return;
    }
    if (resetTimerRef.current !== null) {
      clearTimeout(resetTimerRef.current);
    }
    setCopied(true);
    resetTimerRef.current = setTimeout(() => {
      resetTimerRef.current = null;
      setCopied(false);
    }, COPIED_RESET_MS);
  };

  const currentLabel = copied ? copiedLabel : label;
  const shown = (isCopiedSlot: boolean) =>
    copied === isCopiedSlot ? "opacity-100 scale-100" : "opacity-0 scale-50";

  return (
    <Button
      {...buttonProps}
      aria-label={iconOnly ? currentLabel : undefined}
      className={className}
      data-copied={copied ? "" : undefined}
      onClick={() => {
        handleClick().catch(reportError);
      }}
    >
      <span aria-hidden="true" className="grid place-items-center">
        <CopyIcon className={cn(SWAP_CLASS, shown(false), iconClassName)} />
        <CheckIcon className={cn(SWAP_CLASS, shown(true), iconClassName)} />
      </span>
      {!iconOnly && (
        // Both labels share one grid cell, so the button keeps the wider
        // label's width and nothing beside it shifts.
        <span className="grid">
          <span
            aria-hidden={copied}
            className={cn(SWAP_CLASS, copied ? "opacity-0" : "opacity-100")}
          >
            {label}
          </span>
          <span
            aria-hidden={!copied}
            className={cn(SWAP_CLASS, copied ? "opacity-100" : "opacity-0")}
          >
            {copiedLabel}
          </span>
        </span>
      )}
      <span aria-live="polite" className="sr-only">
        {copied ? copiedLabel : ""}
      </span>
    </Button>
  );
};

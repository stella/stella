"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ComponentProps } from "react";

import { CheckIcon, CopyToClipboardIcon } from "../icons";
import { cn } from "../lib/utils";
import { Button } from "./button";

export const COPIED_RESET_MS = 1500;

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
  /** Classes for the visible label, e.g. to hide it on narrow screens. */
  labelClassName?: string;
};

/**
 * The in-place confirmation behind `CopyButton`, for a copy control whose
 * own content is the thing copied (a reference chip, a permalink mark) and
 * so cannot be a glyph button: `copied` is true for a moment after `copy`
 * succeeds, and the control shows it where the user clicked. No toast.
 */
export const useCopyConfirmation = (onCopy: () => Promise<boolean>) => {
  const { copied, confirm } = useCopiedFeedback();

  const copy = async () => {
    if (!(await onCopy())) {
      return;
    }
    confirm();
  };

  return { copied, copy };
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
  labelClassName,
  className,
  ...buttonProps
}: CopyButtonProps) => {
  const { copied, copy } = useCopyConfirmation(onCopy);

  const currentLabel = copied ? copiedLabel : label;
  return (
    <Button
      {...buttonProps}
      // Named by the current label in both shapes, so the action is found
      // by its name whether or not the label is visible.
      aria-label={currentLabel}
      className={className}
      data-copied={copied ? "" : undefined}
      onClick={() => {
        copy().catch(reportError);
      }}
    >
      <CopyFeedback
        copied={copied}
        copiedLabel={copiedLabel}
        iconClassName={iconClassName}
        iconOnly={iconOnly}
        label={label}
        labelClassName={labelClassName}
      />
    </Button>
  );
};

/** Shared transient state for copy controls that can succeed outside a click. */
export const useCopiedFeedback = () => {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const confirm = useCallback(() => {
    if (resetTimerRef.current !== null) {
      clearTimeout(resetTimerRef.current);
    }
    setCopied(true);
    resetTimerRef.current = setTimeout(() => {
      resetTimerRef.current = null;
      setCopied(false);
    }, COPIED_RESET_MS);
  }, []);

  const reset = useCallback(() => {
    if (resetTimerRef.current !== null) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    setCopied(false);
  }, []);

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) {
        clearTimeout(resetTimerRef.current);
      }
    },
    [],
  );

  return { copied, confirm, reset };
};

type CopyFeedbackProps = {
  icon?: typeof CopyToClipboardIcon | undefined;
  labelClassName?: string | undefined;
  copied: boolean;
  copiedLabel: string;
  iconOnly?: boolean | undefined;
  iconClassName?: string | undefined;
  label: string;
};

/** The standard copy-to-check glyph and label swap, for compound controls. */
export const CopyFeedback = ({
  icon: Icon = CopyToClipboardIcon,
  labelClassName,
  copied,
  copiedLabel,
  iconOnly = false,
  iconClassName = "size-3.5",
  label,
}: CopyFeedbackProps) => {
  const shown = (isCopiedSlot: boolean) =>
    copied === isCopiedSlot ? "opacity-100 scale-100" : "opacity-0 scale-50";

  return (
    <>
      <span aria-hidden="true" className="grid place-items-center">
        <Icon className={cn(SWAP_CLASS, shown(false), iconClassName)} />
        <CheckIcon className={cn(SWAP_CLASS, shown(true), iconClassName)} />
      </span>
      {!iconOnly && (
        // Both labels share one grid cell, so the control keeps the wider
        // label's width and nothing beside it shifts.
        <span className={cn("grid", labelClassName)}>
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
    </>
  );
};

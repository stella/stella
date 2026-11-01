"use client";

import type * as React from "react";

import { cn } from "../lib/utils";

/** Explicit embeddings, overrides and isolates; implicit marks stay. */
const DIRECTIONAL_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/gu;

/**
 * Isolation shields the text around a value, not the value itself: a
 * directional control inside it still reorders its letters, so stored text
 * loses those controls before it renders.
 */
export const withoutDirectionalControls = (
  children: React.ReactNode,
): React.ReactNode =>
  typeof children === "string"
    ? children.replaceAll(DIRECTIONAL_CONTROLS, "")
    : children;

export const BidiText = (props: BidiTextProps) => {
  if (props.as === "span") {
    const { as: _as, children, className, direction = "auto", ...rest } = props;

    return (
      <span
        className={cn("[unicode-bidi:isolate]", className)}
        dir={direction}
        {...rest}
      >
        {withoutDirectionalControls(children)}
      </span>
    );
  }

  if (props.as === "div") {
    const { as: _as, children, className, direction = "auto", ...rest } = props;

    return (
      <div
        className={cn("[unicode-bidi:isolate]", className)}
        dir={direction}
        {...rest}
      >
        {withoutDirectionalControls(children)}
      </div>
    );
  }

  if (props.as === "p") {
    const { as: _as, children, className, direction = "auto", ...rest } = props;

    return (
      <p
        className={cn("[unicode-bidi:isolate]", className)}
        dir={direction}
        {...rest}
      >
        {withoutDirectionalControls(children)}
      </p>
    );
  }

  const { as: _as, children, direction = "auto", ...rest } = props;

  return (
    <bdi dir={direction} {...rest}>
      {withoutDirectionalControls(children)}
    </bdi>
  );
};

export const UserText = BidiText;

type BidiDirection = "auto" | "ltr" | "rtl";

type BdiElementProps = Omit<React.ComponentPropsWithoutRef<"bdi">, "dir"> & {
  as?: "bdi";
  direction?: BidiDirection;
};

type SpanTextProps = Omit<React.ComponentPropsWithoutRef<"span">, "dir"> & {
  as: "span";
  direction?: BidiDirection;
};

type DivTextProps = Omit<React.ComponentPropsWithoutRef<"div">, "dir"> & {
  as: "div";
  direction?: BidiDirection;
};

type ParagraphTextProps = Omit<React.ComponentPropsWithoutRef<"p">, "dir"> & {
  as: "p";
  direction?: BidiDirection;
};

type BidiTextProps =
  BdiElementProps | SpanTextProps | DivTextProps | ParagraphTextProps;

export type { BidiDirection, BidiTextProps };

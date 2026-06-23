"use client";

import type * as React from "react";

import { cn } from "@stll/ui/lib/utils";

export const BidiText = (props: BidiTextProps) => {
  if (props.as === "span") {
    const { as: _as, className, direction = "auto", ...rest } = props;

    return (
      <span
        className={cn("[unicode-bidi:isolate]", className)}
        dir={direction}
        {...rest}
      />
    );
  }

  if (props.as === "div") {
    const { as: _as, className, direction = "auto", ...rest } = props;

    return (
      <div
        className={cn("[unicode-bidi:isolate]", className)}
        dir={direction}
        {...rest}
      />
    );
  }

  if (props.as === "p") {
    const { as: _as, className, direction = "auto", ...rest } = props;

    return (
      <p
        className={cn("[unicode-bidi:isolate]", className)}
        dir={direction}
        {...rest}
      />
    );
  }

  if (props.as === "h1") {
    const { as: _as, className, direction = "auto", ...rest } = props;

    return (
      <h1
        className={cn("[unicode-bidi:isolate]", className)}
        dir={direction}
        {...rest}
      />
    );
  }

  if (props.as === "h2") {
    const { as: _as, className, direction = "auto", ...rest } = props;

    return (
      <h2
        className={cn("[unicode-bidi:isolate]", className)}
        dir={direction}
        {...rest}
      />
    );
  }

  if (props.as === "h3") {
    const { as: _as, className, direction = "auto", ...rest } = props;

    return (
      <h3
        className={cn("[unicode-bidi:isolate]", className)}
        dir={direction}
        {...rest}
      />
    );
  }

  if (props.as === "h4") {
    const { as: _as, className, direction = "auto", ...rest } = props;

    return (
      <h4
        className={cn("[unicode-bidi:isolate]", className)}
        dir={direction}
        {...rest}
      />
    );
  }

  if (props.as === "h5") {
    const { as: _as, className, direction = "auto", ...rest } = props;

    return (
      <h5
        className={cn("[unicode-bidi:isolate]", className)}
        dir={direction}
        {...rest}
      />
    );
  }

  if (props.as === "h6") {
    const { as: _as, className, direction = "auto", ...rest } = props;

    return (
      <h6
        className={cn("[unicode-bidi:isolate]", className)}
        dir={direction}
        {...rest}
      />
    );
  }

  const { as: _as, direction = "auto", ...rest } = props;

  return <bdi dir={direction} {...rest} />;
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

type HeadingTextProps<THeading extends BidiHeadingElement> = Omit<
  React.ComponentPropsWithoutRef<THeading>,
  "dir"
> & {
  as: THeading;
  direction?: BidiDirection;
};

type BidiHeadingElement = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

type BidiTextProps =
  | BdiElementProps
  | SpanTextProps
  | DivTextProps
  | ParagraphTextProps
  | HeadingTextProps<"h1">
  | HeadingTextProps<"h2">
  | HeadingTextProps<"h3">
  | HeadingTextProps<"h4">
  | HeadingTextProps<"h5">
  | HeadingTextProps<"h6">;

export type { BidiDirection, BidiTextProps };

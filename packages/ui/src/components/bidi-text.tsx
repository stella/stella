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

  const { as: _as, direction = "auto", ...rest } = props;

  return <bdi dir={direction} {...rest} />;
};

export const UserText = BidiText;

type BidiDirection = "auto" | "ltr" | "rtl";

type BdiTextProps = Omit<React.ComponentPropsWithoutRef<"bdi">, "dir"> & {
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
  | BdiTextProps
  | SpanTextProps
  | DivTextProps
  | ParagraphTextProps;

export type { BidiDirection, BidiTextProps };

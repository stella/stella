import type { ComponentProps } from "react";

import { cn } from "../lib/utils";
import {
  TEXT_VARIANT_CLASS_NAMES,
  TEXT_VARIANT_FACES,
  type TextContract,
  type TextFace,
} from "./text.shared";

const WEIGHT_CLASS_NAMES = {
  light: "font-light",
  regular: "font-normal",
  medium: "font-medium",
  semibold: "font-semibold",
  bold: "font-bold",
} as const satisfies Record<TextFace["weight"], string>;

const faceClassName = (face: TextFace): string =>
  cn(
    face.family === "serif" && "font-serif",
    WEIGHT_CLASS_NAMES[face.weight],
    face.italic === true && "italic",
  );

/**
 * Text in one of the design system's roles (./text.shared.ts), the same role
 * the React Native renderer (./text.native.tsx) sets on a phone. Inline, so a
 * role can sit inside a paragraph; a block of prose is `Prose`.
 */
const Text = ({
  className,
  variant = "body",
  ...props
}: Omit<ComponentProps<"span">, keyof TextContract> & TextContract) => (
  <span
    className={cn(
      "text-foreground",
      TEXT_VARIANT_CLASS_NAMES[variant],
      faceClassName(TEXT_VARIANT_FACES[variant]),
      className,
    )}
    data-slot="text"
    data-variant={variant}
    {...props}
  />
);

export { Text };
export type { TextVariant } from "./text.shared";

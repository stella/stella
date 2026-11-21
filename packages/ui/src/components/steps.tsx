import type * as React from "react";

import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils";

const stepsVariants = cva("list-decimal ps-6 marker:font-medium", {
  variants: {
    variant: {
      default: "space-y-4",
      compact: "space-y-0.5",
      progress: "grid grid-cols-4 gap-2",
    },
  },
  defaultVariants: { variant: "default" },
});

type StepsProps = React.ComponentProps<"ol"> &
  VariantProps<typeof stepsVariants> & {
    markerStyle: NonNullable<React.CSSProperties["listStyleType"]>;
  };

/** A meaningful procedure, timeline, or ranking. The list owns its numbers. */
const Steps = ({
  className,
  variant,
  markerStyle,
  style,
  ...props
}: StepsProps) => (
  <ol
    className={cn(stepsVariants({ variant }), className)}
    data-slot="steps"
    style={{ ...style, listStyleType: markerStyle }}
    {...props}
  />
);

const stepVariants = cva("ps-2", {
  variants: {
    status: {
      current: "border-foreground border-t-2 pt-2 text-sm font-medium",
      completed: "border-foreground border-t-2 pt-2 text-sm font-medium",
      upcoming: "border-muted text-muted-foreground border-t-2 pt-2 text-sm",
    },
  },
});

type StepProps = React.ComponentProps<"li"> & VariantProps<typeof stepVariants>;

const Step = ({ className, status, ...props }: StepProps) => (
  <li
    className={cn(stepVariants({ status }), className)}
    data-slot="step"
    {...props}
  />
);

export { Step, Steps };

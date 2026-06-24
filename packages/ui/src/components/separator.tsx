import type { PropsWithChildren } from "react";

import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";

import { cn } from "@stll/ui/lib/utils";

function Separator({
  className,
  orientation = "horizontal",
  ...props
}: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      className={cn(
        "bg-border shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:not-[[class^='h-']]:not-[[class*='_h-']]:self-stretch",
        className,
      )}
      data-slot="separator"
      orientation={orientation}
      {...props}
    />
  );
}

type TextSeparatorProps = PropsWithChildren<{
  /** Container overrides, e.g. gap or vertical padding. */
  className?: string;
  /** Label overrides, e.g. casing or size. */
  labelClassName?: string;
}>;

/** Horizontal rule with a centered label — the "or sign in with email" /
 *  "or build a new one" divider that frames an either/or choice. The label
 *  names the alternative; flanking hairlines split the two options. */
function TextSeparator({
  children,
  className,
  labelClassName,
}: TextSeparatorProps) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <span className="bg-border h-px flex-1" />
      <span className={cn("text-muted-foreground text-xs", labelClassName)}>
        {children}
      </span>
      <span className="bg-border h-px flex-1" />
    </div>
  );
}

export { Separator, TextSeparator };

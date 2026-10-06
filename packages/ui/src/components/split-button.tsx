"use client";

import type { ComponentProps, ReactNode } from "react";

import { ChevronDownIcon } from "../icons";
import { cn } from "../lib/utils";
import { Button } from "./button";
import { Menu, MenuTrigger } from "./menu";

type SplitButtonProps = {
  primaryLabel: string;
  menuLabel: string;
  primaryDescriptionId?: string;
  menuDescriptionId?: string;
  onPrimaryClick: NonNullable<ComponentProps<typeof Button>["onClick"]>;
  children: ReactNode;
  menu: ReactNode;
  primaryDisabled?: boolean;
  menuDisabled?: boolean;
  size?: "sm" | "md";
  className?: string;
  open?: ComponentProps<typeof Menu>["open"];
  onOpenChange?: ComponentProps<typeof Menu>["onOpenChange"];
};

/** Two independent actions share quiet chrome; only the chevron owns the menu. */
export const SplitButton = ({
  primaryLabel,
  menuLabel,
  primaryDescriptionId,
  menuDescriptionId,
  onPrimaryClick,
  children,
  menu,
  primaryDisabled,
  menuDisabled,
  size = "md",
  className,
  open,
  onOpenChange,
}: SplitButtonProps) => (
  <Menu onOpenChange={onOpenChange} open={open}>
    <div
      className={cn(
        "group/split hover:border-border focus-within:border-border has-[[data-popup-open]]:border-border inline-flex shrink-0 items-center rounded-lg border border-transparent p-0.5",
        className,
      )}
      data-size={size}
      data-slot="split-button"
    >
      <Button
        aria-describedby={primaryDescriptionId}
        aria-label={primaryLabel}
        className={cn(
          "text-muted-foreground hover:text-foreground active:bg-accent/80 rounded-md [&_svg]:size-3.5",
          size === "sm" ? "h-7 px-1.5 sm:h-7" : "h-8 px-2 sm:h-8",
          "pointer-coarse:min-h-11 pointer-coarse:min-w-11",
        )}
        disabled={primaryDisabled}
        onClick={onPrimaryClick}
        size="sm"
        variant="ghost"
      >
        {children}
      </Button>
      <MenuTrigger
        aria-describedby={menuDescriptionId}
        aria-label={menuLabel}
        disabled={menuDisabled}
        render={
          <Button
            className={cn(
              "text-muted-foreground group-hover/split:bg-muted group-focus-within/split:bg-muted hover:bg-accent hover:text-foreground active:bg-accent/80 data-popup-open:bg-accent rounded-md [&_svg]:size-3",
              size === "sm" ? "h-7 w-5 px-0 sm:h-7" : "h-8 w-6 px-0 sm:h-8",
              "pointer-coarse:min-h-11 pointer-coarse:min-w-11",
            )}
            size="sm"
            variant="ghost"
          />
        }
      >
        <ChevronDownIcon aria-hidden="true" />
      </MenuTrigger>
    </div>
    {menu}
  </Menu>
);

"use client";

import type { ComponentProps, ReactNode } from "react";

import { ChevronDownIcon } from "../icons";
import { cn } from "../lib/utils";
import { Button } from "./button";
import { Menu, MenuTrigger } from "./menu";
import { Popover, PopoverTrigger } from "./popover";

type SplitButtonSharedProps = {
  menuLabel: string;
  primaryDescriptionId?: string;
  menuDescriptionId?: string;
  onPrimaryClick: NonNullable<ComponentProps<typeof Button>["onClick"]>;
  menu: ReactNode;
  primaryDisabled?: boolean;
  menuDisabled?: boolean;
  size?: "sm" | "md";
  className?: string;
};

type SplitButtonPrimary =
  | { children: ReactNode; primaryLabel: string }
  | { children: string; primaryLabel?: never };

type SplitButtonProps = SplitButtonSharedProps &
  SplitButtonPrimary &
  (
    | {
        surface?: "menu";
        open?: ComponentProps<typeof Menu>["open"];
        onOpenChange?: ComponentProps<typeof Menu>["onOpenChange"];
      }
    | {
        surface: "popover";
        open?: ComponentProps<typeof Popover>["open"];
        onOpenChange?: ComponentProps<typeof Popover>["onOpenChange"];
      }
  );

/** Two independent actions share quiet chrome; only the chevron opens the secondary surface. */
export const SplitButton = (props: SplitButtonProps) => {
  const {
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
  } = props;
  const triggerButton = (
    <Button
      className={cn(
        "text-muted-foreground group-hover/split:bg-muted group-focus-within/split:bg-muted hover:bg-accent hover:text-foreground active:bg-accent/80 data-popup-open:bg-accent rounded-md [&_svg]:mx-0",
        size === "sm" ? "h-7 w-3.5 px-0 sm:h-7" : "h-8 w-4 px-0 sm:h-8",
        "pointer-coarse:min-h-11 pointer-coarse:min-w-11",
      )}
      size="sm"
      variant="ghost"
    />
  );
  const controls = (
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
          "text-muted-foreground hover:text-foreground active:bg-accent/80 rounded-md [&_svg]:mx-0 [&_svg]:size-3.5 [&_svg:not([class*='size-'])]:size-3.5 sm:[&_svg:not([class*='size-'])]:size-3.5",
          size === "sm" ? "h-7 ps-1.5 pe-0.5 sm:h-7" : "h-8 ps-2 pe-0.5 sm:h-8",
          "pointer-coarse:min-h-11 pointer-coarse:min-w-11",
        )}
        disabled={primaryDisabled}
        onClick={onPrimaryClick}
        size="sm"
        variant="ghost"
      >
        {children}
      </Button>
      {props.surface === "popover" ? (
        <PopoverTrigger
          aria-describedby={menuDescriptionId}
          aria-label={menuLabel}
          disabled={menuDisabled}
          render={triggerButton}
        >
          <ChevronDownIcon
            aria-hidden="true"
            className="size-2.25"
            strokeWidth={1.5}
          />
        </PopoverTrigger>
      ) : (
        <MenuTrigger
          aria-describedby={menuDescriptionId}
          aria-label={menuLabel}
          disabled={menuDisabled}
          render={triggerButton}
        >
          <ChevronDownIcon
            aria-hidden="true"
            className="size-2.25"
            strokeWidth={1.5}
          />
        </MenuTrigger>
      )}
    </div>
  );
  if (props.surface === "popover") {
    return (
      <Popover onOpenChange={props.onOpenChange} open={props.open}>
        {controls}
        {menu}
      </Popover>
    );
  }
  return (
    <Menu onOpenChange={props.onOpenChange} open={props.open}>
      {controls}
      {menu}
    </Menu>
  );
};

"use client";

import type { ComponentProps, ReactNode } from "react";

import { cn } from "../lib/utils";
import { Button, BUTTON_CONTENT } from "./button";
import {
  SPLIT_BUTTON_PRIMARY_CLASS,
  SPLIT_BUTTON_ROOT_CLASS,
  SPLIT_BUTTON_TRIGGER_CLASS,
  SplitButtonChevron,
  type SplitButtonSize,
} from "./control-face";
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
  size?: SplitButtonSize;
  className?: string;
};

// Rich primary content names itself through `primaryLabel` and says what it
// shows: a glyph alone gets that name as its tooltip, visible text gets none.
type SplitButtonPrimary =
  | {
      children: ReactNode;
      primaryContent: (typeof BUTTON_CONTENT)[keyof typeof BUTTON_CONTENT];
      primaryLabel: string;
    }
  | { children: string; primaryContent?: never; primaryLabel?: never };

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

/**
 * Two independent actions share quiet chrome; only the chevron opens the
 * secondary surface. The chrome is quiet, not the glyphs: both halves keep the
 * foreground colour of every other ghost button, so an enabled split button
 * never reads as disabled beside its neighbours.
 */
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
      className={SPLIT_BUTTON_TRIGGER_CLASS[size]}
      size="sm"
      tooltip={menuLabel}
      variant="ghost"
    />
  );
  const controls = (
    <div
      className={cn(SPLIT_BUTTON_ROOT_CLASS, className)}
      data-size={size}
      data-slot="split-button"
    >
      <Button
        aria-describedby={primaryDescriptionId}
        aria-label={primaryLabel}
        className={SPLIT_BUTTON_PRIMARY_CLASS[size]}
        disabled={primaryDisabled}
        onClick={onPrimaryClick}
        size="sm"
        tooltip={
          props.primaryContent === BUTTON_CONTENT.icon
            ? primaryLabel
            : undefined
        }
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
          <SplitButtonChevron />
        </PopoverTrigger>
      ) : (
        <MenuTrigger
          aria-describedby={menuDescriptionId}
          aria-label={menuLabel}
          disabled={menuDisabled}
          render={triggerButton}
        >
          <SplitButtonChevron />
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

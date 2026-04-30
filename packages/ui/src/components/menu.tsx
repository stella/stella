"use client";

import type * as React from "react";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "@stll/ui/lib/utils";
import { ChevronRightIcon } from "lucide-react";

const MenuCreateHandle = MenuPrimitive.createHandle;

const Menu = MenuPrimitive.Root;

const MenuPortal = MenuPrimitive.Portal;

function MenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return (
    <MenuPrimitive.Trigger data-slot="menu-trigger" nativeButton {...props} />
  );
}

function MenuPopup({
  children,
  className,
  sideOffset = 4,
  align = "center",
  alignOffset,
  side = "bottom",
  anchor,
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props["align"];
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: MenuPrimitive.Positioner.Props["alignOffset"];
  side?: MenuPrimitive.Positioner.Props["side"];
  anchor?: MenuPrimitive.Positioner.Props["anchor"];
}) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        align={anchor ? "start" : align}
        alignOffset={alignOffset}
        anchor={anchor}
        className="z-50"
        data-slot="menu-positioner"
        side={anchor ? "bottom" : side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          className={cn(
            "bg-popover relative flex origin-(--transform-origin) rounded-lg border shadow-lg/5 outline-none not-dark:bg-clip-padding not-[class*='w-']:min-w-32 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] focus:outline-none dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            className,
          )}
          data-slot="menu-popup"
          {...props}
        >
          <div className="max-h-(--available-height) w-full overflow-y-auto p-1">
            {children}
          </div>
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function MenuGroup(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="menu-group" {...props} />;
}

function MenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <MenuPrimitive.Item
      className={cn(
        "text-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground data-[variant=destructive]:text-destructive-foreground flex min-h-8 cursor-default items-center gap-2 rounded-sm px-2 py-1 text-base outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-64 data-inset:ps-8 sm:min-h-7 sm:text-sm [&>svg]:pointer-events-none [&>svg]:-mx-0.5 [&>svg]:shrink-0 [&>svg:not([class*='opacity-'])]:opacity-80 [&>svg:not([class*='size-'])]:size-4.5 sm:[&>svg:not([class*='size-'])]:size-4",
        className,
      )}
      data-inset={inset}
      data-slot="menu-item"
      data-variant={variant}
      {...props}
    />
  );
}

function MenuCheckboxItem({
  className,
  children,
  checked,
  variant = "default",
  ...props
}: MenuPrimitive.CheckboxItem.Props & {
  variant?: "default" | "switch";
}) {
  return (
    <MenuPrimitive.CheckboxItem
      checked={checked}
      className={cn(
        "text-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground grid min-h-8 cursor-default items-center gap-2 rounded-sm py-1 ps-2 text-base outline-none in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] data-disabled:pointer-events-none data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
        variant === "switch"
          ? "grid-cols-[1fr_auto] gap-4 pe-1.5"
          : "grid-cols-[1rem_1fr] pe-4",
        className,
      )}
      data-slot="menu-checkbox-item"
      {...props}
    >
      {variant === "switch" ? (
        <>
          <span className="col-start-1">{children}</span>
          <MenuPrimitive.CheckboxItemIndicator
            className="focus-visible:ring-ring focus-visible:ring-offset-background data-checked:bg-primary data-unchecked:bg-input inline-flex h-[calc(var(--thumb-size)+2px)] w-[calc(var(--thumb-size)*2-2px)] shrink-0 items-center rounded-full p-px inset-shadow-[0_1px_--theme(--color-black/4%)] transition-[background-color,box-shadow] duration-200 outline-none [--thumb-size:--spacing(4)] focus-visible:ring-2 focus-visible:ring-offset-1 data-disabled:opacity-64 sm:[--thumb-size:--spacing(3)]"
            keepMounted
          >
            <span className="bg-background pointer-events-none block aspect-square h-full origin-left rounded-(--thumb-size) shadow-sm/5 will-change-transform [transition:translate_.15s,border-radius_.15s,scale_.1s_.1s,transform-origin_.15s] in-[[data-slot=menu-checkbox-item]:active]:rounded-[var(--thumb-size)/calc(var(--thumb-size)*1.10)] in-[[data-slot=menu-checkbox-item]:active]:not-data-disabled:scale-x-110 in-[[data-slot=menu-checkbox-item][data-checked]]:origin-[var(--thumb-size)_50%] in-[[data-slot=menu-checkbox-item][data-checked]]:translate-x-[calc(var(--thumb-size)-4px)]" />
          </MenuPrimitive.CheckboxItemIndicator>
        </>
      ) : (
        <>
          <MenuPrimitive.CheckboxItemIndicator className="col-start-1">
            <svg
              fill="none"
              height="24"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              viewBox="0 0 24 24"
              width="24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <title>Selected</title>
              <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
            </svg>
          </MenuPrimitive.CheckboxItemIndicator>
          <span className="col-start-2">{children}</span>
        </>
      )}
    </MenuPrimitive.CheckboxItem>
  );
}

function MenuRadioGroup(props: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="menu-radio-group" {...props} />;
}

function MenuRadioItem({
  className,
  children,
  ...props
}: MenuPrimitive.RadioItem.Props) {
  return (
    <MenuPrimitive.RadioItem
      className={cn(
        "text-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground grid min-h-8 cursor-default grid-cols-[1rem_1fr] items-center gap-2 rounded-sm py-1 ps-2 pe-4 text-base outline-none in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] data-disabled:pointer-events-none data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      data-slot="menu-radio-item"
      {...props}
    >
      <MenuPrimitive.RadioItemIndicator className="col-start-1">
        <svg
          fill="none"
          height="24"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width="24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <title>Selected</title>
          <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
        </svg>
      </MenuPrimitive.RadioItemIndicator>
      <span className="col-start-2">{children}</span>
    </MenuPrimitive.RadioItem>
  );
}

function MenuGroupLabel({
  className,
  inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.GroupLabel
      className={cn(
        "text-muted-foreground px-2 py-1.5 text-xs font-medium data-inset:ps-9 sm:data-inset:ps-8",
        className,
      )}
      data-inset={inset}
      data-slot="menu-label"
      {...props}
    />
  );
}

function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      className={cn("bg-border mx-2 my-1 h-px", className)}
      data-slot="menu-separator"
      {...props}
    />
  );
}

function MenuShortcut({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "text-muted-foreground/72 ms-auto font-sans text-xs font-medium tracking-widest",
        className,
      )}
      data-slot="menu-shortcut"
      {...props}
    />
  );
}

function MenuSub(props: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="menu-sub" {...props} />;
}

function MenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.SubmenuTrigger
      className={cn(
        "text-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground data-popup-open:bg-accent data-popup-open:text-accent-foreground flex min-h-8 items-center gap-2 rounded-sm px-2 py-1 text-base outline-none data-disabled:pointer-events-none data-disabled:opacity-64 data-inset:ps-8 sm:min-h-7 sm:text-sm [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      data-inset={inset}
      data-slot="menu-sub-trigger"
      {...props}
    >
      {children}
      <ChevronRightIcon className="ms-auto -me-0.5 opacity-80" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

function MenuSubPopup({
  className,
  sideOffset = 0,
  alignOffset,
  align = "start",
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props["align"];
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: MenuPrimitive.Positioner.Props["alignOffset"];
}) {
  const defaultAlignOffset = align !== "center" ? -5 : undefined;

  return (
    <MenuPopup
      align={align}
      alignOffset={alignOffset ?? defaultAlignOffset}
      className={className}
      data-slot="menu-sub-content"
      side="inline-end"
      sideOffset={sideOffset}
      {...props}
    />
  );
}

export {
  MenuCreateHandle,
  MenuCreateHandle as DropdownMenuCreateHandle,
  Menu,
  Menu as DropdownMenu,
  MenuPortal,
  MenuPortal as DropdownMenuPortal,
  MenuTrigger,
  MenuTrigger as DropdownMenuTrigger,
  MenuPopup,
  MenuPopup as DropdownMenuContent,
  MenuGroup,
  MenuGroup as DropdownMenuGroup,
  MenuItem,
  MenuItem as DropdownMenuItem,
  MenuCheckboxItem,
  MenuCheckboxItem as DropdownMenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioGroup as DropdownMenuRadioGroup,
  MenuRadioItem,
  MenuRadioItem as DropdownMenuRadioItem,
  MenuGroupLabel,
  MenuGroupLabel as DropdownMenuLabel,
  MenuSeparator,
  MenuSeparator as DropdownMenuSeparator,
  MenuShortcut,
  MenuShortcut as DropdownMenuShortcut,
  MenuSub,
  MenuSub as DropdownMenuSub,
  MenuSubTrigger,
  MenuSubTrigger as DropdownMenuSubTrigger,
  MenuSubPopup,
  MenuSubPopup as DropdownMenuSubContent,
};

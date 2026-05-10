"use client";

import type * as React from "react";

import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { SearchIcon } from "lucide-react";

import { DialogPopup } from "@stll/ui/components/dialog";
import { cn } from "@stll/ui/lib/utils";

type CommandProps<ItemValue> = Omit<
  AutocompletePrimitive.Root.Props<ItemValue>,
  "items"
> & {
  items?: readonly ItemValue[] | undefined;
};

function Command<ItemValue>({
  autoHighlight = "always",
  keepHighlight = true,
  open = true,
  ...props
}: CommandProps<ItemValue>): React.JSX.Element {
  return (
    <AutocompletePrimitive.Root
      autoHighlight={autoHighlight}
      keepHighlight={keepHighlight}
      open={open}
      {...props}
    />
  );
}

const CommandDialog = DialogPrimitive.Root;

function CommandDialogTrigger(props: DialogPrimitive.Trigger.Props) {
  return (
    <DialogPrimitive.Trigger data-slot="command-dialog-trigger" {...props} />
  );
}

function CommandDialogPopup({
  className,
  showCloseButton = false,
  ...props
}: React.ComponentProps<typeof DialogPopup>) {
  return (
    <DialogPopup
      className={cn("overflow-hidden p-0", className)}
      data-slot="command-dialog-popup"
      showCloseButton={showCloseButton}
      {...props}
    />
  );
}

type CommandInputProps = Omit<AutocompletePrimitive.Input.Props, "size"> & {
  size?: "sm" | "default" | "lg" | number;
  wrapperClassName?: string;
  ref?: React.Ref<HTMLInputElement>;
};

function CommandInput({
  className,
  size = "lg",
  wrapperClassName,
  ...props
}: CommandInputProps) {
  return (
    <div
      className={cn("flex min-w-0 flex-1 items-center gap-3", wrapperClassName)}
      data-slot="command-input-wrapper"
    >
      <SearchIcon className="text-muted-foreground size-5 shrink-0" />
      <AutocompletePrimitive.Input
        className={cn(
          "placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-base outline-none disabled:cursor-not-allowed disabled:opacity-64 sm:text-sm",
          size === "sm" && "h-7 text-sm",
          size === "default" && "h-8",
          size === "lg" && "h-9",
          className,
        )}
        data-slot="command-input"
        size={typeof size === "number" ? size : undefined}
        {...props}
      />
    </div>
  );
}

function CommandPanel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "bg-popover text-popover-foreground flex min-h-0 flex-col rounded-lg border shadow-lg/5",
        className,
      )}
      data-slot="command-panel"
      {...props}
    />
  );
}

function CommandEmpty({
  className,
  ...props
}: AutocompletePrimitive.Empty.Props) {
  return (
    <AutocompletePrimitive.Empty
      className={cn(
        "text-muted-foreground py-6 text-center text-sm",
        className,
      )}
      data-slot="command-empty"
      {...props}
    />
  );
}

function CommandList({
  className,
  ...props
}: AutocompletePrimitive.List.Props & {
  ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    <AutocompletePrimitive.List
      className={cn(
        "max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto",
        className,
      )}
      data-slot="command-list"
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: AutocompletePrimitive.Group.Props) {
  return (
    <AutocompletePrimitive.Group
      className={cn("text-foreground overflow-hidden p-1", className)}
      data-slot="command-group"
      {...props}
    />
  );
}

function CommandGroupLabel({
  className,
  ...props
}: AutocompletePrimitive.GroupLabel.Props) {
  return (
    <AutocompletePrimitive.GroupLabel
      className={cn(
        "text-muted-foreground px-2 py-1.5 text-xs font-medium",
        className,
      )}
      data-slot="command-group-label"
      {...props}
    />
  );
}

function CommandCollection(props: AutocompletePrimitive.Collection.Props) {
  return (
    <AutocompletePrimitive.Collection
      data-slot="command-collection"
      {...props}
    />
  );
}

function CommandItem({
  className,
  ...props
}: AutocompletePrimitive.Item.Props & {
  ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    <AutocompletePrimitive.Item
      className={cn(
        "data-highlighted:bg-accent data-highlighted:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-64 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      data-slot="command-item"
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: AutocompletePrimitive.Separator.Props) {
  return (
    <AutocompletePrimitive.Separator
      className={cn("bg-border -mx-1 h-px", className)}
      data-slot="command-separator"
      {...props}
    />
  );
}

function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      className={cn("text-muted-foreground ms-auto text-xs", className)}
      data-slot="command-shortcut"
      {...props}
    />
  );
}

function CommandFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "text-muted-foreground flex items-center justify-between border-t px-3 py-2 text-xs",
        className,
      )}
      data-slot="command-footer"
      {...props}
    />
  );
}

export {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandDialogTrigger,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandSeparator,
  CommandShortcut,
};

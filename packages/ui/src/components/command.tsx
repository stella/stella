"use client";

import type * as React from "react";

import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { SearchIcon } from "lucide-react";

import { useContentDir } from "../hooks/use-content-dir";
import { CONTROL_SIZE } from "../lib/control-size";
import type { ControlSize } from "../lib/control-size";
import { cn } from "../lib/utils";
import { DialogPopup } from "./dialog";

type CommandProps<ItemValue> = Omit<
  AutocompletePrimitive.Root.Props<ItemValue>,
  "items"
> & {
  items?: readonly ItemValue[] | undefined;
};

const Command = <ItemValue,>({
  autoHighlight = "always",
  keepHighlight = true,
  open = true,
  ...props
}: CommandProps<ItemValue>): React.JSX.Element => (
  <AutocompletePrimitive.Root
    autoHighlight={autoHighlight}
    keepHighlight={keepHighlight}
    open={open}
    {...props}
  />
);

const CommandDialog = DialogPrimitive.Root;

const CommandDialogTrigger = (props: DialogPrimitive.Trigger.Props) => (
  <DialogPrimitive.Trigger data-slot="command-dialog-trigger" {...props} />
);

const CommandDialogPopup = ({
  className,
  showCloseButton = false,
  ...props
}: React.ComponentProps<typeof DialogPopup>) => (
  <DialogPopup
    className={cn("overflow-hidden p-0", className)}
    data-slot="command-dialog-popup"
    showCloseButton={showCloseButton}
    {...props}
  />
);

type CommandInputProps = Omit<AutocompletePrimitive.Input.Props, "size"> & {
  size?: ControlSize | number;
  wrapperClassName?: string;
  ref?: React.Ref<HTMLInputElement>;
};

const CommandInput = ({
  className,
  size = CONTROL_SIZE.lg,
  wrapperClassName,
  dir,
  onChange,
  ...props
}: CommandInputProps) => {
  // Base UI's Autocomplete owns the value at the root, so onChange only fires
  // for native typing — a programmatic value (e.g. a recent search) would not
  // update it. A controlled consumer can therefore pass an explicit
  // `dir={contentDir(value)}` which wins; otherwise fall back to tracking the
  // typed text here.
  const tracked = useContentDir({
    dir: undefined,
    value: undefined,
    defaultValue: undefined,
  });
  const handleChange: NonNullable<CommandInputProps["onChange"]> = (event) => {
    tracked.trackValue(event.currentTarget.value);
    onChange?.(event);
  };
  return (
    <div
      className={cn("flex min-w-0 flex-1 items-center gap-3", wrapperClassName)}
      data-slot="command-input-wrapper"
    >
      <SearchIcon className="text-muted-foreground size-5 shrink-0" />
      <AutocompletePrimitive.Input
        className={cn(
          "placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-base outline-none disabled:cursor-not-allowed disabled:opacity-64 sm:text-sm",
          typeof size === "number"
            ? undefined
            : COMMAND_INPUT_SIZE_CLASS_NAMES[size],
          className,
        )}
        data-slot="command-input"
        size={typeof size === "number" ? size : undefined}
        {...props}
        dir={dir ?? tracked.dir}
        onChange={handleChange}
      />
    </div>
  );
};

const COMMAND_INPUT_SIZE_CLASS_NAMES = {
  [CONTROL_SIZE.sm]: "h-7 text-sm",
  [CONTROL_SIZE.default]: "h-8",
  [CONTROL_SIZE.lg]: "h-9",
} as const satisfies Record<ControlSize, string>;

const CommandPanel = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div
    className={cn(
      "bg-popover text-popover-foreground flex min-h-0 flex-col rounded-lg border shadow-lg/5",
      className,
    )}
    data-slot="command-panel"
    {...props}
  />
);

const CommandEmpty = ({
  className,
  ...props
}: AutocompletePrimitive.Empty.Props) => (
  <AutocompletePrimitive.Empty
    className={cn("text-muted-foreground py-6 text-center text-sm", className)}
    data-slot="command-empty"
    {...props}
  />
);

const CommandList = ({
  className,
  ...props
}: AutocompletePrimitive.List.Props & {
  ref?: React.Ref<HTMLDivElement>;
}) => (
  <AutocompletePrimitive.List
    className={cn(
      "max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto",
      className,
    )}
    data-slot="command-list"
    {...props}
  />
);

const CommandGroup = ({
  className,
  ...props
}: AutocompletePrimitive.Group.Props) => (
  <AutocompletePrimitive.Group
    className={cn("text-foreground overflow-hidden p-1", className)}
    data-slot="command-group"
    {...props}
  />
);

const CommandGroupLabel = ({
  className,
  ...props
}: AutocompletePrimitive.GroupLabel.Props) => (
  <AutocompletePrimitive.GroupLabel
    className={cn(
      "text-muted-foreground px-2 py-1.5 text-xs font-medium",
      className,
    )}
    data-slot="command-group-label"
    {...props}
  />
);

const CommandCollection = (props: AutocompletePrimitive.Collection.Props) => (
  <AutocompletePrimitive.Collection data-slot="command-collection" {...props} />
);

const CommandItem = ({
  className,
  ...props
}: AutocompletePrimitive.Item.Props & {
  ref?: React.Ref<HTMLDivElement>;
}) => (
  <AutocompletePrimitive.Item
    className={cn(
      "data-highlighted:bg-accent data-highlighted:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-64 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
      className,
    )}
    data-slot="command-item"
    {...props}
  />
);

const CommandSeparator = ({
  className,
  ...props
}: AutocompletePrimitive.Separator.Props) => (
  <AutocompletePrimitive.Separator
    className={cn("bg-border -mx-1 h-px", className)}
    data-slot="command-separator"
    {...props}
  />
);

const CommandShortcut = ({
  className,
  ...props
}: React.ComponentProps<"span">) => (
  <span
    className={cn("text-muted-foreground ms-auto text-xs", className)}
    data-slot="command-shortcut"
    {...props}
  />
);

const CommandFooter = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn(
      "text-muted-foreground flex items-center justify-between border-t px-3 py-2 text-xs",
      className,
    )}
    data-slot="command-footer"
    {...props}
  />
);

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

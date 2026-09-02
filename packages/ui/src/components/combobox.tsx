"use client";

import * as React from "react";

import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { ChevronsUpDownIcon, XIcon } from "lucide-react";

import { containedHandler } from "../hooks/use-contained-handler";
import { CONTROL_SIZE } from "../lib/control-size";
import type { ControlSize } from "../lib/control-size";
import { OVERLAY_LAYER_CLASS_NAMES } from "../lib/overlay-layer";
import { cn } from "../lib/utils";
import { Input } from "./input";
import { ScrollArea } from "./scroll-area";

const ComboboxContext = React.createContext<{
  chipsRef: React.RefObject<HTMLDivElement | null> | null;
  multiple: boolean;
}>({
  chipsRef: null,
  multiple: false,
});

const Combobox = <Value, Multiple extends boolean | undefined = false>(
  props: ComboboxPrimitive.Root.Props<Value, Multiple>,
): React.JSX.Element => {
  const chipsRef = React.useRef<HTMLDivElement | null>(null);
  const contextValue = React.useMemo(
    () => ({ chipsRef, multiple: !!props.multiple }),
    [chipsRef, props.multiple],
  );
  return (
    <ComboboxContext value={contextValue}>
      <ComboboxPrimitive.Root {...props} />
    </ComboboxContext>
  );
};

const ComboboxChipsInput = ({
  className,
  size,
  ...props
}: Omit<ComboboxPrimitive.Input.Props, "size"> & {
  size?: ControlSize | number;
  ref?: React.Ref<HTMLInputElement>;
}) => {
  const sizeValue = size ?? CONTROL_SIZE.default;
  const controlSize =
    typeof sizeValue === "number" ? CONTROL_SIZE.default : sizeValue;

  return (
    <ComboboxPrimitive.Input
      className={cn(
        "min-w-12 flex-1 text-base outline-none sm:text-sm [[data-slot=combobox-chip]+&]:ps-0.5",
        COMBOBOX_CHIPS_INPUT_SIZE_CLASS_NAMES[controlSize],
        className,
      )}
      data-size={typeof sizeValue === "string" ? sizeValue : undefined}
      data-slot="combobox-chips-input"
      size={typeof sizeValue === "number" ? sizeValue : undefined}
      {...props}
    />
  );
};

const ComboboxInput = ({
  className,
  showTrigger = true,
  showClear = false,
  startAddon,
  size,
  ...props
}: Omit<ComboboxPrimitive.Input.Props, "size"> & {
  showTrigger?: boolean;
  showClear?: boolean;
  startAddon?: React.ReactNode;
  size?: ControlSize | number;
  ref?: React.Ref<HTMLInputElement>;
}) => {
  const sizeValue = size ?? CONTROL_SIZE.default;
  const controlSize =
    typeof sizeValue === "number" ? CONTROL_SIZE.default : sizeValue;

  return (
    <ComboboxPrimitive.InputGroup className="text-foreground relative w-full not-has-[>*.w-full]:w-fit has-disabled:opacity-64">
      {Boolean(startAddon) && (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-y-0 start-px z-10 flex items-center opacity-80 [&_svg]:-mx-0.5 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
            COMBOBOX_START_ADDON_SIZE_CLASS_NAMES[controlSize],
          )}
          data-slot="combobox-start-addon"
        >
          {startAddon}
        </div>
      )}
      <ComboboxPrimitive.Input
        className={cn(
          Boolean(startAddon) &&
            COMBOBOX_INPUT_START_ADDON_SIZE_CLASS_NAMES[controlSize],
          COMBOBOX_INPUT_SIZE_CLASS_NAMES[controlSize],
          className,
        )}
        data-slot="combobox-input"
        render={
          <Input
            className="has-disabled:opacity-100"
            nativeInput
            size={sizeValue}
          />
        }
        {...props}
      />
      {showTrigger && (
        <ComboboxTrigger
          className={cn(
            "absolute top-1/2 inline-flex size-8 shrink-0 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md border border-transparent opacity-80 transition-opacity outline-none hover:opacity-100 has-[+[data-slot=combobox-clear]]:hidden sm:size-7 pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
            COMBOBOX_ACTION_SIZE_CLASS_NAMES[controlSize],
          )}
        >
          <ChevronsUpDownIcon />
        </ComboboxTrigger>
      )}
      {showClear && (
        <ComboboxClear
          className={cn(
            "absolute top-1/2 inline-flex size-8 shrink-0 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md border border-transparent opacity-80 transition-opacity outline-none hover:opacity-100 has-[+[data-slot=combobox-clear]]:hidden sm:size-7 pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
            COMBOBOX_ACTION_SIZE_CLASS_NAMES[controlSize],
          )}
        >
          <XIcon />
        </ComboboxClear>
      )}
    </ComboboxPrimitive.InputGroup>
  );
};

const COMBOBOX_CHIPS_INPUT_SIZE_CLASS_NAMES = {
  [CONTROL_SIZE.sm]: "ps-1.5",
  [CONTROL_SIZE.default]: "ps-2",
  [CONTROL_SIZE.lg]: "ps-2",
} as const satisfies Record<ControlSize, string>;

const COMBOBOX_START_ADDON_SIZE_CLASS_NAMES = {
  [CONTROL_SIZE.sm]: "ps-[calc(--spacing(2.5)-1px)]",
  [CONTROL_SIZE.default]: "ps-[calc(--spacing(3)-1px)]",
  [CONTROL_SIZE.lg]: "ps-[calc(--spacing(3)-1px)]",
} as const satisfies Record<ControlSize, string>;

const COMBOBOX_INPUT_START_ADDON_SIZE_CLASS_NAMES = {
  [CONTROL_SIZE.sm]:
    "*:data-[slot=combobox-input]:ps-[calc(--spacing(7.5)-1px)] sm:*:data-[slot=combobox-input]:ps-[calc(--spacing(7)-1px)]",
  [CONTROL_SIZE.default]:
    "*:data-[slot=combobox-input]:ps-[calc(--spacing(8.5)-1px)] sm:*:data-[slot=combobox-input]:ps-[calc(--spacing(8)-1px)]",
  [CONTROL_SIZE.lg]:
    "*:data-[slot=combobox-input]:ps-[calc(--spacing(8.5)-1px)] sm:*:data-[slot=combobox-input]:ps-[calc(--spacing(8)-1px)]",
} as const satisfies Record<ControlSize, string>;

const COMBOBOX_INPUT_SIZE_CLASS_NAMES = {
  [CONTROL_SIZE.sm]:
    "has-[+[data-slot=combobox-trigger],+[data-slot=combobox-clear]]:*:data-[slot=combobox-input]:pe-6.5",
  [CONTROL_SIZE.default]:
    "has-[+[data-slot=combobox-trigger],+[data-slot=combobox-clear]]:*:data-[slot=combobox-input]:pe-7",
  [CONTROL_SIZE.lg]:
    "has-[+[data-slot=combobox-trigger],+[data-slot=combobox-clear]]:*:data-[slot=combobox-input]:pe-7",
} as const satisfies Record<ControlSize, string>;

const COMBOBOX_ACTION_SIZE_CLASS_NAMES = {
  [CONTROL_SIZE.sm]: "end-0",
  [CONTROL_SIZE.default]: "end-0.5",
  [CONTROL_SIZE.lg]: "end-0.5",
} as const satisfies Record<ControlSize, string>;

const ComboboxTrigger = ({
  className,
  ...props
}: ComboboxPrimitive.Trigger.Props) => (
  <ComboboxPrimitive.Trigger
    className={className}
    data-slot="combobox-trigger"
    {...props}
  />
);

const ComboboxPopup = ({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  alignOffset,
  align = "start",
  ...props
}: ComboboxPrimitive.Popup.Props & {
  align?: ComboboxPrimitive.Positioner.Props["align"];
  sideOffset?: ComboboxPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: ComboboxPrimitive.Positioner.Props["alignOffset"];
  side?: ComboboxPrimitive.Positioner.Props["side"];
}) => {
  const { chipsRef } = React.use(ComboboxContext);

  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={chipsRef}
        className={cn(OVERLAY_LAYER_CLASS_NAMES.popup, "select-none")}
        data-slot="combobox-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <span
          className={cn(
            "bg-popover relative flex max-h-full max-w-(--available-width) min-w-(--anchor-width) origin-(--transform-origin) rounded-lg border shadow-lg/5 transition-[scale,opacity] not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            className,
          )}
        >
          <ComboboxPrimitive.Popup
            className="text-foreground flex max-h-[min(var(--available-height),23rem)] flex-1 flex-col"
            data-slot="combobox-popup"
            {...props}
          >
            {children}
          </ComboboxPrimitive.Popup>
        </span>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
};

const ComboboxItem = ({
  className,
  children,
  ...props
}: ComboboxPrimitive.Item.Props) => (
  <ComboboxPrimitive.Item
    className={cn(
      "data-highlighted:bg-accent data-highlighted:text-accent-foreground grid min-h-8 cursor-default grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 rounded-sm py-1 ps-2 pe-4 text-base outline-none in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] data-disabled:pointer-events-none data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
      className,
    )}
    data-slot="combobox-item"
    {...props}
  >
    <ComboboxPrimitive.ItemIndicator className="col-start-1">
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
    </ComboboxPrimitive.ItemIndicator>
    <div className="col-start-2 min-w-0">{children}</div>
  </ComboboxPrimitive.Item>
);

const ComboboxSeparator = ({
  className,
  ...props
}: ComboboxPrimitive.Separator.Props) => (
  <ComboboxPrimitive.Separator
    className={cn("bg-border mx-2 my-1 h-px last:hidden", className)}
    data-slot="combobox-separator"
    {...props}
  />
);

const ComboboxGroup = ({
  className,
  ...props
}: ComboboxPrimitive.Group.Props) => (
  <ComboboxPrimitive.Group
    className={cn("[[role=group]+&]:mt-1.5", className)}
    data-slot="combobox-group"
    {...props}
  />
);

const ComboboxGroupLabel = ({
  className,
  ...props
}: ComboboxPrimitive.GroupLabel.Props) => (
  <ComboboxPrimitive.GroupLabel
    className={cn(
      "text-muted-foreground px-2 py-1.5 text-xs font-medium",
      className,
    )}
    data-slot="combobox-group-label"
    {...props}
  />
);

const ComboboxEmpty = ({
  className,
  ...props
}: ComboboxPrimitive.Empty.Props) => (
  <ComboboxPrimitive.Empty
    className={cn(
      "text-muted-foreground text-center text-base not-empty:p-2 sm:text-sm",
      className,
    )}
    data-slot="combobox-empty"
    {...props}
  />
);

const ComboboxRow = ({ className, ...props }: ComboboxPrimitive.Row.Props) => (
  <ComboboxPrimitive.Row
    className={className}
    data-slot="combobox-row"
    {...props}
  />
);

const ComboboxValue = ({ ...props }: ComboboxPrimitive.Value.Props) => (
  <ComboboxPrimitive.Value data-slot="combobox-value" {...props} />
);

const ComboboxList = ({
  className,
  ...props
}: ComboboxPrimitive.List.Props) => (
  <ScrollArea scrollbarGutter scrollFade>
    <ComboboxPrimitive.List
      className={cn(
        "not-empty:scroll-py-1 not-empty:px-1 not-empty:py-1 in-data-has-overflow-y:pe-3",
        className,
      )}
      data-slot="combobox-list"
      {...props}
    />
  </ScrollArea>
);

const ComboboxClear = ({
  className,
  ...props
}: ComboboxPrimitive.Clear.Props) => (
  <ComboboxPrimitive.Clear
    className={className}
    data-slot="combobox-clear"
    {...props}
  />
);

const ComboboxStatus = ({
  className,
  ...props
}: ComboboxPrimitive.Status.Props) => (
  <ComboboxPrimitive.Status
    className={cn(
      "text-muted-foreground px-3 py-2 text-xs font-medium empty:m-0 empty:p-0",
      className,
    )}
    data-slot="combobox-status"
    {...props}
  />
);

const ComboboxCollection = (props: ComboboxPrimitive.Collection.Props) => (
  <ComboboxPrimitive.Collection data-slot="combobox-collection" {...props} />
);

const ComboboxChips = ({
  className,
  children,
  startAddon,
  ...props
}: ComboboxPrimitive.Chips.Props & {
  startAddon?: React.ReactNode;
}) => {
  const { chipsRef } = React.use(ComboboxContext);

  return (
    <ComboboxPrimitive.Chips
      className={cn(
        "border-input bg-background ring-ring/24 focus-within:border-ring has-autofill:bg-foreground/4 has-aria-invalid:border-destructive/36 focus-within:has-aria-invalid:border-destructive/64 focus-within:has-aria-invalid:ring-destructive/16 dark:not-has-disabled:bg-input/32 dark:has-autofill:bg-foreground/8 dark:has-aria-invalid:ring-destructive/24 relative inline-flex min-h-9 w-full flex-wrap gap-1 rounded-lg border p-[calc(--spacing(1)-1px)] text-base shadow-xs/5 transition-shadow outline-none *:min-h-7 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-disabled:not-focus-within:not-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] focus-within:ring-[3px] has-disabled:pointer-events-none has-disabled:opacity-64 has-data-[size=lg]:min-h-10 has-data-[size=lg]:*:min-h-8 has-data-[size=sm]:min-h-8 has-data-[size=sm]:*:min-h-6 has-[:disabled,:focus-within,[aria-invalid]]:shadow-none sm:min-h-8 sm:text-sm sm:*:min-h-6 sm:has-data-[size=lg]:min-h-9 sm:has-data-[size=lg]:*:min-h-7 sm:has-data-[size=sm]:min-h-7 sm:has-data-[size=sm]:*:min-h-5 dark:not-has-disabled:not-focus-within:not-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)]",
        className,
      )}
      data-slot="combobox-chips"
      // eslint-disable-next-line react/react-compiler -- containedHandler receives the ref object, not a render-time `.current` read; this ref+containedHandler shape is mandated by require-contained-handler
      onMouseDown={containedHandler(chipsRef, (e) => {
        const { target } = e;
        if (!(target instanceof Element)) {
          return;
        }
        const isChip = target.closest('[data-slot="combobox-chip"]');
        if (isChip || !chipsRef?.current) {
          return;
        }
        e.preventDefault();
        const input: HTMLInputElement | null =
          chipsRef.current.querySelector("input");
        if (input && !chipsRef.current.querySelector("input:focus")) {
          input.focus();
        }
      })}
      ref={chipsRef}
      {...props}
    >
      {Boolean(startAddon) && (
        <div
          aria-hidden="true"
          className="flex shrink-0 items-center ps-2 opacity-80 has-[+[data-slot=combobox-chip]]:pe-2 has-[~[data-size=sm]]:ps-1.5 has-[~[data-size=sm]]:has-[+[data-slot=combobox-chip]]:pe-1.5 [&_svg]:pointer-events-none [&_svg]:-ms-0.5 [&_svg]:-me-1.5 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4"
          data-slot="combobox-start-addon"
        >
          {startAddon}
        </div>
      )}
      {children}
    </ComboboxPrimitive.Chips>
  );
};

const ComboboxChip = ({ children, ...props }: ComboboxPrimitive.Chip.Props) => (
  <ComboboxPrimitive.Chip
    className="bg-accent text-accent-foreground flex items-center rounded-[calc(var(--radius-md)-1px)] ps-2 text-sm font-medium outline-none sm:text-xs/(--text-xs--line-height) [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5"
    data-slot="combobox-chip"
    {...props}
  >
    {children}
    <ComboboxChipRemove />
  </ComboboxPrimitive.Chip>
);

const ComboboxChipRemove = (props: ComboboxPrimitive.ChipRemove.Props) => (
  <ComboboxPrimitive.ChipRemove
    aria-label="Remove"
    className="h-full shrink-0 cursor-pointer px-1.5 opacity-80 hover:opacity-100 [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5"
    data-slot="combobox-chip-remove"
    {...props}
  >
    <XIcon />
  </ComboboxPrimitive.ChipRemove>
);

const useComboboxFilter = ComboboxPrimitive.useFilter;

export {
  Combobox,
  ComboboxChipsInput,
  ComboboxInput,
  ComboboxTrigger,
  ComboboxPopup,
  ComboboxItem,
  ComboboxSeparator,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxEmpty,
  ComboboxValue,
  ComboboxList,
  ComboboxClear,
  ComboboxStatus,
  ComboboxRow,
  ComboboxCollection,
  ComboboxChips,
  ComboboxChip,
  useComboboxFilter,
};

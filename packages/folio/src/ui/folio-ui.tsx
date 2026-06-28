import { createContext, useContext } from "react";
import type {
  ComponentProps,
  ComponentType,
  CSSProperties,
  ReactNode,
  RefAttributes,
} from "react";

import type { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import type { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { Select as SelectPrimitive } from "@base-ui/react/select";

import { DefaultButton } from "./defaults/button";
import { DefaultCheckbox } from "./defaults/checkbox";
import { DefaultDialog } from "./defaults/dialog";
import { DefaultInput } from "./defaults/input";
import { DefaultMenu } from "./defaults/menu";
import { DefaultPopover } from "./defaults/popover";
import { DefaultSelect } from "./defaults/select";

/**
 * Folio chrome (toolbars, dialogs, pickers, find/replace) renders UI primitives
 * that a consumer can override with its own design system. Each entry in
 * {@link FolioUIComponents} is a React component (or a part-object of compound
 * sub-components) folio's chrome renders; the contract grows as more primitives
 * are decoupled from a hard design-system dependency.
 *
 * Compound primitives (Dialog, Select, Menu, Popover) are modeled as
 * part-objects: a typed record of their sub-parts (`Root`, `Popup`, …). Chrome
 * destructures the parts it needs from {@link useFolioUI}; the part shape keeps
 * one key per primitive in the contract and lets the app inject a flat
 * design-system module as a small adapter object. Each part's props are the
 * subset of the underlying `@base-ui/react` part's props folio relies on, so an
 * external component (which accepts a superset) stays assignable as an override.
 *
 * Standalone folio uses {@link DEFAULT_COMPONENTS} (built on `@base-ui/react`,
 * the neutral primitive the app design system also wraps); consumers inject
 * overrides through `DocxEditor`'s `components` prop.
 */

// ============================================================================
// Button
// ============================================================================

/**
 * The Button prop subset folio's chrome actually relies on. `variant` and
 * `size` are deliberately narrow string-literal unions: each is a subset of the
 * design-system Button's options so an external Button stays assignable as an
 * override. Native attributes are picked from `<button>` so their types match
 * exactly.
 */
export type FolioButtonProps = Pick<
  ComponentProps<"button">,
  | "onClick"
  | "onMouseDown"
  | "className"
  | "disabled"
  | "type"
  | "title"
  | "aria-label"
  | "aria-pressed"
  | "children"
> & {
  variant?: "default" | "ghost";
  size?: "sm" | "xs" | "icon-xs";
};

// ============================================================================
// Dialog
// ============================================================================

export type FolioDialogRootProps = Pick<
  DialogPrimitive.Root.Props,
  "open" | "onOpenChange"
> & { children?: ReactNode };
export type FolioDialogPortalProps = { children?: ReactNode };
export type FolioDialogBackdropProps = { className?: string };
export type FolioDialogPopupProps = {
  className?: string;
  children?: ReactNode;
};
export type FolioDialogTitleProps = {
  className?: string;
  children?: ReactNode;
};
export type FolioDialogCloseProps = {
  className?: string;
  children?: ReactNode;
};

export type FolioDialog = {
  Root: ComponentType<FolioDialogRootProps>;
  Portal: ComponentType<FolioDialogPortalProps>;
  Backdrop: ComponentType<FolioDialogBackdropProps>;
  Popup: ComponentType<FolioDialogPopupProps>;
  Title: ComponentType<FolioDialogTitleProps>;
  Close: ComponentType<FolioDialogCloseProps>;
};

// ============================================================================
// Select
// ============================================================================

export type FolioSelectRootProps = Pick<
  SelectPrimitive.Root.Props<string>,
  "value" | "onValueChange" | "disabled" | "items"
> & { children?: ReactNode };
export type FolioSelectTriggerProps = Pick<
  SelectPrimitive.Trigger.Props,
  "style"
> & {
  className?: string;
  children?: ReactNode;
  size?: "sm" | "default" | "lg";
  "data-folio-style-picker"?: string;
};
export type FolioSelectValueProps = Pick<
  SelectPrimitive.Value.Props,
  "placeholder"
> & {
  className?: string;
  children?: ReactNode;
};
export type FolioSelectPopupProps = {
  className?: string;
  children?: ReactNode;
};
export type FolioSelectItemProps = Pick<SelectPrimitive.Item.Props, "value"> & {
  className?: string;
  children?: ReactNode;
};

export type FolioSelect = {
  Root: ComponentType<FolioSelectRootProps>;
  Trigger: ComponentType<FolioSelectTriggerProps>;
  Value: ComponentType<FolioSelectValueProps>;
  Popup: ComponentType<FolioSelectPopupProps>;
  Item: ComponentType<FolioSelectItemProps>;
};

// ============================================================================
// Menu
// ============================================================================

export type FolioMenuRootProps = { children?: ReactNode };
export type FolioMenuTriggerProps = Pick<
  MenuPrimitive.Trigger.Props,
  "render" | "disabled" | "type" | "aria-label" | "onMouseDown"
> & {
  className?: string;
  children?: ReactNode;
  nativeButton?: boolean;
};
export type FolioMenuPopupProps = {
  className?: string;
  children?: ReactNode;
  align?: MenuPrimitive.Positioner.Props["align"];
  side?: MenuPrimitive.Positioner.Props["side"];
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: MenuPrimitive.Positioner.Props["alignOffset"];
};
export type FolioMenuItemProps = Pick<MenuPrimitive.Item.Props, "onClick"> & {
  className?: string;
  children?: ReactNode;
};
export type FolioMenuCheckboxItemProps = Pick<
  MenuPrimitive.CheckboxItem.Props,
  "checked" | "onCheckedChange"
> & {
  className?: string;
  children?: ReactNode;
};
export type FolioMenuGroupProps = { children?: ReactNode };
export type FolioMenuGroupLabelProps = {
  className?: string;
  children?: ReactNode;
};
export type FolioMenuSeparatorProps = { className?: string };

export type FolioMenu = {
  Root: ComponentType<FolioMenuRootProps>;
  Trigger: ComponentType<FolioMenuTriggerProps>;
  Popup: ComponentType<FolioMenuPopupProps>;
  Item: ComponentType<FolioMenuItemProps>;
  CheckboxItem: ComponentType<FolioMenuCheckboxItemProps>;
  Group: ComponentType<FolioMenuGroupProps>;
  GroupLabel: ComponentType<FolioMenuGroupLabelProps>;
  Separator: ComponentType<FolioMenuSeparatorProps>;
};

// ============================================================================
// Popover
// ============================================================================

export type FolioPopoverRootProps = { children?: ReactNode };
export type FolioPopoverTriggerProps = Pick<
  PopoverPrimitive.Trigger.Props,
  "disabled" | "render"
> & {
  className?: string;
  children?: ReactNode;
  "data-testid"?: string;
};
export type FolioPopoverPopupProps = Pick<
  PopoverPrimitive.Popup.Props,
  "onMouseDown"
> & {
  className?: string;
  children?: ReactNode;
  side?: PopoverPrimitive.Positioner.Props["side"];
  align?: PopoverPrimitive.Positioner.Props["align"];
  sideOffset?: PopoverPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: PopoverPrimitive.Positioner.Props["alignOffset"];
};
export type FolioPopoverCloseProps = Pick<
  PopoverPrimitive.Close.Props,
  "render"
> & {
  className?: string;
  children?: ReactNode;
};

export type FolioPopover = {
  Root: ComponentType<FolioPopoverRootProps>;
  Trigger: ComponentType<FolioPopoverTriggerProps>;
  Popup: ComponentType<FolioPopoverPopupProps>;
  Close: ComponentType<FolioPopoverCloseProps>;
};

// ============================================================================
// Input / Checkbox (single primitives)
// ============================================================================

export type FolioInputProps = Omit<
  ComponentProps<"input">,
  "size" | "ref" | "style"
> &
  RefAttributes<HTMLInputElement> & {
    style?: CSSProperties;
    size?: "sm" | "default" | "lg" | number;
    nativeInput?: boolean;
  };

export type FolioCheckboxProps = Pick<
  CheckboxPrimitive.Root.Props,
  "checked" | "onCheckedChange"
> & { className?: string };

// ============================================================================
// Contract + context
// ============================================================================

export type FolioUIComponents = {
  Button: ComponentType<FolioButtonProps>;
  Dialog: FolioDialog;
  Select: FolioSelect;
  Menu: FolioMenu;
  Popover: FolioPopover;
  Input: ComponentType<FolioInputProps>;
  Checkbox: ComponentType<FolioCheckboxProps>;
};

export const DEFAULT_COMPONENTS: FolioUIComponents = {
  Button: DefaultButton,
  Dialog: DefaultDialog,
  Select: DefaultSelect,
  Menu: DefaultMenu,
  Popover: DefaultPopover,
  Input: DefaultInput,
  Checkbox: DefaultCheckbox,
};

const FolioUIContext = createContext<FolioUIComponents>(DEFAULT_COMPONENTS);

export function FolioUIProvider({
  components,
  children,
}: {
  components?: Partial<FolioUIComponents> | undefined;
  children: ReactNode;
}) {
  const value = components
    ? { ...DEFAULT_COMPONENTS, ...components }
    : DEFAULT_COMPONENTS;
  return (
    <FolioUIContext.Provider value={value}>{children}</FolioUIContext.Provider>
  );
}

export function useFolioUI(): FolioUIComponents {
  return useContext(FolioUIContext);
}

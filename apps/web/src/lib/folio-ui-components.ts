import { createElement } from "react";
import type { ComponentProps } from "react";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { FolioUIComponents } from "@stll/folio-react";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { ColorPicker } from "@stll/ui/color-picker";
import type { ColorPickerProps } from "@stll/ui/color-picker";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogPortal,
  DialogTitle,
} from "@stll/ui/dialog";
import { Input } from "@stll/ui/input";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@stll/ui/menu";
import { OutlineRail } from "@stll/ui/outline-rail";
import {
  Popover,
  PopoverClose,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { DatePickerPopover } from "@/components/date-picker-popover";

const LocalizedColorPicker = (props: Omit<ColorPickerProps, "moreLabel">) => {
  const t = useTranslations();

  return createElement(ColorPicker, {
    ...props,
    moreLabel: t("common.showMore"),
  });
};

/**
 * Folio owns the dialog portal and backdrop around this part. The app's
 * composite DialogPopup cannot be injected here because it creates another
 * portal, backdrop, and z-index stacking context around the popup.
 */
type FolioInputProps = ComponentProps<FolioUIComponents["Input"]>;

// Folio's contract admits every native input type; the design system routes
// file pickers through `FileInput`, so a file request here is a contract gap.
const FolioInput = ({ type, ...props }: FolioInputProps) => {
  if (type === "file") {
    return panic("folio requested an Input of type file; use FileInput");
  }
  return createElement(Input, { ...props, type });
};

const FolioDialogPopup = (props: DialogPrimitive.Popup.Props) =>
  createElement(DialogPrimitive.Popup, props);

/**
 * Chrome UI primitives injected into folio's `DocxEditor` so the editor keeps
 * the app's design system while folio itself stays UI-agnostic. The object
 * grows as folio decouples more primitives; render sites pass it once and need
 * no further edits when the contract expands.
 *
 * Folio models compound primitives (Dialog, Select, Menu, Popover) as
 * part-objects (`{ Root, Popup, … }`); the design system exports them as flat
 * named components, so each compound entry is a small adapter mapping the flat
 * exports onto the part shape.
 */
export const folioUIComponents: Partial<FolioUIComponents> = {
  Button,
  Checkbox,
  Input: FolioInput,
  ColorPicker: LocalizedColorPicker,
  DatePickerPopover,
  OutlineRail,
  Dialog: {
    Root: Dialog,
    Portal: DialogPortal,
    Backdrop: DialogBackdrop,
    Popup: FolioDialogPopup,
    Title: DialogTitle,
    Close: DialogClose,
  },
  Select: {
    Root: Select,
    Trigger: SelectTrigger,
    Value: SelectValue,
    Popup: SelectPopup,
    Item: SelectItem,
  },
  Menu: {
    Root: Menu,
    Trigger: MenuTrigger,
    Popup: MenuPopup,
    Item: MenuItem,
    CheckboxItem: MenuCheckboxItem,
    Group: MenuGroup,
    GroupLabel: MenuGroupLabel,
    Separator: MenuSeparator,
  },
  Popover: {
    Root: Popover,
    Trigger: PopoverTrigger,
    Popup: PopoverPopup,
    Close: PopoverClose,
  },
};

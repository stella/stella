import type { FolioUIComponents } from "@stll/folio";
import { Button } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";
import { ColorPicker } from "@stll/ui/components/color-picker";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogPopup,
  DialogPortal,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { Input } from "@stll/ui/components/input";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@stll/ui/components/menu";
import { OutlineRail } from "@stll/ui/components/outline-rail";
import {
  Popover,
  PopoverClose,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";

import { DatePickerPopover } from "@/components/date-picker-popover";

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
  Input,
  ColorPicker,
  DatePickerPopover,
  OutlineRail,
  Dialog: {
    Root: Dialog,
    Portal: DialogPortal,
    Backdrop: DialogBackdrop,
    Popup: DialogPopup,
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

// Passive regression fixture for
// `no-dialog-trigger-menu-item/no-dialog-trigger-menu-item`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag; if
// the rule regresses the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. Lines without a
// directive cover the allow-list and must keep passing.

import { AlertDialog, AlertDialogTrigger } from "@stll/ui/alert-dialog";
import { ContextMenuItem } from "@stll/ui/context-menu";
import { DialogTrigger } from "@stll/ui/dialog";
import { DropdownMenuItem } from "@stll/ui/dropdown-menu";
import { Menu, MenuItem, MenuSubTrigger } from "@stll/ui/menu";
import { PopoverTrigger } from "@stll/ui/popover";
import { SheetTrigger } from "@stll/ui/sheet";

const t = (key: string) => key;
const noop = () => undefined;
const open = false;

// --- Flagged: menu item as the trigger's `render` target ---
export const _a = () => (
  // oxlint-disable-next-line no-dialog-trigger-menu-item/no-dialog-trigger-menu-item
  <AlertDialogTrigger
    render={<MenuItem closeOnClick={false} variant="destructive" />}
  >
    {t("common.delete")}
  </AlertDialogTrigger>
);
export const _b = () => (
  // oxlint-disable-next-line no-dialog-trigger-menu-item/no-dialog-trigger-menu-item
  <DialogTrigger render={<MenuItem closeOnClick={false} />}>
    {t("common.rename")}
  </DialogTrigger>
);
export const _c = () => (
  // oxlint-disable-next-line no-dialog-trigger-menu-item/no-dialog-trigger-menu-item
  <SheetTrigger render={<ContextMenuItem closeOnClick={false} />}>
    {t("common.share")}
  </SheetTrigger>
);
export const _d = () => (
  // oxlint-disable-next-line no-dialog-trigger-menu-item/no-dialog-trigger-menu-item
  <PopoverTrigger render={<DropdownMenuItem closeOnClick={false} />}>
    {t("common.export")}
  </PopoverTrigger>
);
export const _e = () => (
  // oxlint-disable-next-line no-dialog-trigger-menu-item/no-dialog-trigger-menu-item
  <AlertDialogTrigger render={<MenuSubTrigger closeOnClick={false} />}>
    {t("common.more")}
  </AlertDialogTrigger>
);

// --- Flagged: menu item as a direct child instead of `render` ---
export const _f = () => (
  // oxlint-disable-next-line no-dialog-trigger-menu-item/no-dialog-trigger-menu-item
  <DialogTrigger>
    <MenuItem closeOnClick={false}>{t("common.rename")}</MenuItem>
  </DialogTrigger>
);

// --- Allowed: the dialog is lifted beside the menu with `open` state ---
export const _ok1 = () => (
  <>
    <Menu>
      <MenuItem onClick={noop} variant="destructive">
        {t("common.delete")}
      </MenuItem>
    </Menu>
    <AlertDialog onOpenChange={noop} open={open} />
  </>
);
// Allowed: a trigger whose render target is not a menu item.
export const _ok2 = () => (
  <DialogTrigger render={<button type="button">{t("common.edit")}</button>} />
);
// Allowed: a menu item with no dialog trigger around it.
export const _ok3 = () => <MenuItem>{t("common.duplicate")}</MenuItem>;
// Allowed: an enabled Popover trigger around an ordinary button, not a menu item.
export const _ok4 = () => <PopoverTrigger render={<button type="button" />} />;

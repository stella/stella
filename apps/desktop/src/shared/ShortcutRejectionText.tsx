import { panic } from "better-result";
import { useLocale, useTranslations } from "use-intl";

import {
  formatShortcut,
  modifierLabel,
  SHORTCUT_TRIGGER_MODIFIERS,
} from "./shortcut-keys";
import type {
  KeyboardLayout,
  ShortcutKeys,
  ShortcutRejection,
} from "./shortcut-keys";
import { DESKTOP_PLATFORM } from "./use-clipboard-shortcut";

type ShortcutRejectionTextProps = {
  candidate: ShortcutKeys;
  layout: KeyboardLayout | null;
  rejection: ShortcutRejection;
};

/** The sentence for a shortcut the native rules or the OS refused. */
export const ShortcutRejectionText = ({
  candidate,
  layout,
  rejection,
}: ShortcutRejectionTextProps) => {
  const t = useTranslations("shortcut");
  const locale = useLocale();
  const shortcut = formatShortcut({
    keys: candidate,
    layout,
    locale,
    platform: DESKTOP_PLATFORM,
  });
  switch (rejection.reason) {
    case "needsModifier":
      return t("needsModifier", {
        modifiers: new Intl.ListFormat(locale, { type: "disjunction" }).format(
          SHORTCUT_TRIGGER_MODIFIERS[DESKTOP_PLATFORM].map((modifier) =>
            modifierLabel({ locale, modifier, platform: DESKTOP_PLATFORM }),
          ),
        ),
      });
    case "unsupportedKey":
      return t("unsupportedKey");
    case "systemReserved":
      return t("systemReserved", {
        action: t(`action.${rejection.action}`),
        shortcut,
      });
    case "windowsKeyReserved":
      return t("windowsKeyReserved");
    case "taken":
      return t("taken", { shortcut });
    default:
      rejection satisfies never;
      return panic("Unknown shortcut rejection.");
  }
};

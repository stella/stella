import type { DesktopLinkRefusal } from "@/features/desktop/desktop-connection-store.logic";
import type { TranslationKey } from "@/i18n/types";

/** What the page says about a link the app on this computer refused. */
export const DESKTOP_LINK_REFUSAL_MESSAGE = {
  account_conflict: "settings.account.desktopAccountConflict",
  switch_declined: "settings.account.desktopKeptAccount",
  declined: "settings.account.desktopConnectDeclined",
} as const satisfies Record<DesktopLinkRefusal, TranslationKey>;

import { createContext, use } from "react";
import type { PropsWithChildren } from "react";

import { useTranslations } from "use-intl";

import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

// Whether the app's intl is mounted above. A pending view also renders where
// it is not (the server's cold-load paint, the locale gate), so it may not
// call `useTranslations` itself.
const PendingIntlContext = createContext(false);

/**
 * Whether the app's intl is mounted above, for a label `PendingText` cannot
 * name (a frame's nav label): render its text only then.
 */
export const useIntlMounted = (): boolean => use(PendingIntlContext);

/** Marks the subtree where the app's intl provider has its messages. */
export const PendingTextIntlScope = ({ children }: PropsWithChildren) => (
  <PendingIntlContext value>{children}</PendingIntlContext>
);

// The static labels pending views show. A closed union keeps the
// translator's key type small (`t` checks each one is a real message); a
// page adds its labels here as it gains a pending view.
export type PendingTextKey =
  | "agentSetup.addressLabel"
  | "agentSetup.copy"
  | "agentSetup.description"
  | "agentSetup.pasteHint"
  | "agentSetup.selfSetupHint"
  | "agentSetup.title"
  | "appearance.calendar"
  | "appearance.numbers"
  | "appearance.regionalFormat"
  | "appearance.weekStart"
  | "chat.greeting"
  | "chat.landing.recentChats"
  | "chat.landing.skills"
  | "chat.newChat"
  | "chat.placeholder"
  | "common.active"
  | "common.add"
  | "common.displayName"
  | "common.history"
  | "common.language"
  | "common.profile"
  | "common.save"
  | "common.search"
  | "common.selectAMatter"
  | "common.sessions"
  | "common.stale"
  | "common.timeBilling"
  | "common.workflows"
  | "knowledge.sections.workflows.description"
  | "lawHome.prompt"
  | "lawHome.recent"
  | "lawHome.signals"
  | "lawHome.topCourts"
  | "memory.pageDescription"
  | "memory.pageTitle"
  | "memory.tabs.firm"
  | "memory.tabs.matter"
  | "memory.tabs.mine"
  | "memory.views.archived"
  | "navigation.shortcutsDialog.title"
  | "settings.account.beta"
  | "settings.account.betaDescription"
  | "settings.account.betaInbox"
  | "settings.account.betaInboxDescription"
  | "settings.account.betaLocalAgents"
  | "settings.account.betaLocalAgentsDescription"
  | "settings.account.betaTimeBillingDescription"
  | "settings.account.chatNotifications"
  | "settings.account.chatNotificationsDescription"
  | "settings.account.chatNotificationsToggle"
  | "settings.account.dangerZone"
  | "settings.account.dangerZoneDescription"
  | "settings.account.deleteAccount"
  | "settings.account.deleteAccountWarning"
  | "settings.account.desktop"
  | "settings.account.desktopAppDescription"
  | "settings.account.desktopClipboardDescription"
  | "settings.account.desktopClipboardTitle"
  | "settings.account.desktopDescription"
  | "settings.account.desktopDocumentsDescription"
  | "settings.account.desktopDocumentsTitle"
  | "settings.account.desktopHeroTitle"
  | "settings.account.desktopPrivacyDescription"
  | "settings.account.desktopPrivacyTitle"
  | "settings.account.displayNameDescription"
  | "settings.account.personalDataExportDescription"
  | "settings.account.personalDataExportRequest"
  | "settings.account.personalDataExportTitle"
  | "settings.account.preferredName"
  | "settings.account.preferredNameDescription"
  | "settings.account.profileDescription"
  | "settings.account.signInMethods.description"
  | "settings.account.signInMethods.title"
  | "settings.account.timezone"
  | "settings.account.timezoneDescription"
  | "settings.account.title"
  | "settings.account.twoFactor.description"
  | "settings.account.twoFactor.title"
  | "settings.account.wordEditShortcut"
  | "settings.account.wordEditShortcutDescription"
  | "settings.connections.cliDescription"
  | "settings.connections.cliTitle"
  | "settings.connections.connectedAppsDescription"
  | "settings.connections.connectedAppsTitle"
  | "settings.connections.description"
  | "settings.connections.integrationsDescription"
  | "settings.connections.integrationsTitle"
  | "settings.connections.mcpSetupHint"
  | "settings.connections.mcpTitle"
  | "settings.connections.searchPlaceholder"
  | "settings.connections.title";

const TranslatedText = ({ id }: { id: PendingTextKey }) => {
  const t = useTranslations();
  return t(id);
};

/**
 * A static label in a pending view: the translated message where the app's
 * intl is mounted, and a bar on the label's own line where it is not yet, so
 * the label never moves when the text arrives.
 */
export const PendingText = ({
  barClassName = "w-24",
  id,
}: {
  /** The bar's width, roughly the label's. */
  barClassName?: string | undefined;
  id: PendingTextKey;
}) =>
  use(PendingIntlContext) ? (
    <TranslatedText id={id} />
  ) : (
    // One line box of the surrounding text, so the bar keeps the label's
    // height inside a flex row as well as in running text. Top-aligned: on
    // the baseline, an inline box with no text of its own adds a descent and
    // grows the line by a pixel.
    <span
      aria-hidden="true"
      className="inline-flex h-[1lh] items-center align-top"
    >
      <Skeleton className={cn("h-[0.75em]", barClassName)} />
    </span>
  );

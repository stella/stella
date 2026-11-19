import { createContext, use } from "react";
import type { PropsWithChildren } from "react";

import { useTranslations } from "use-intl";

import { InlineSkeleton } from "@stll/ui/skeleton";
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
type PendingTextMessageKey =
  | "auth.continueWithEmail"
  | "auth.emailPlaceholder"
  | "auth.error.generic"
  | "auth.error.providerUnavailable"
  | "auth.error.title"
  | "auth.handoffTitle"
  | "auth.headline"
  | "auth.invitation.title"
  | "auth.professionalUse.title"
  | "auth.professionalUseStatement"
  | "auth.reauthenticationRequired"
  | "auth.signIn"
  | "auth.signInBeforeInvitation"
  | "auth.subtitle"
  | "auth.twoFactor.enterAuthenticatorCode"
  | "auth.twoFactor.title"
  | "auth.twoFactor.useBackupCode"
  | "auth.useDifferentEmail"
  | "chat.greeting"
  | "chat.landing.recentChats"
  | "chat.landing.skills"
  | "chat.newChat"
  | "chat.placeholder"
  | "common.accept"
  | "common.active"
  | "common.cancel"
  | "common.confirm"
  | "common.decline"
  | "common.history"
  | "common.matter"
  | "common.newMatter"
  | "common.reference"
  | "common.search"
  | "common.selectAMatter"
  | "common.signOut"
  | "common.today"
  | "common.tryAgain"
  | "common.verify"
  | "common.workflows"
  | "guidance.notCaseLaw"
  | "lawHome.prompt"
  | "lawHome.recent"
  | "lawHome.signals"
  | "lawHome.topCourts"
  | "memory.views.archived"
  | "workspaces.overview.nextDeadline"
  | "workspaces.overview.openTasks"
  | "workspaces.overview.timeThisWeek"
  | "workspaces.overview.totalDocuments"
  | "workspaces.overview.totalItems"
  | "workspaces.parties.client"
  | "workspaces.team"
  | "workspaces.views.layouts.grid"
  | "workspaces.views.layouts.table";

// Messages whose label is their text before one placeholder: a column called
// "Last active" from "Last active {time}". The placeholder is left empty and
// the rest trimmed, the one way every surface names that column.
type PendingTextLeadKey = "common.createdAt" | "workspaces.lastActive";

export type PendingTextKey = PendingTextMessageKey | PendingTextLeadKey;

/**
 * A pending label's text, as the loaded page shows the same label: for a
 * live surface that names a thing the way its pending view does.
 */
export const usePendingTextLabel = (): ((id: PendingTextKey) => string) => {
  const t = useTranslations();
  return (id) => {
    if (id === "common.createdAt") {
      return t(id, { date: "" }).trim();
    }
    if (id === "workspaces.lastActive") {
      return t(id, { time: "" }).trim();
    }
    return t(id);
  };
};

const TranslatedText = ({ id }: { id: PendingTextKey }) =>
  usePendingTextLabel()(id);

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
      <InlineSkeleton className={cn("h-[0.75em]", barClassName)} />
    </span>
  );

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
type PendingTextKey =
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
  | "common.accept"
  | "common.cancel"
  | "common.confirm"
  | "common.decline"
  | "common.signOut"
  | "common.tryAgain"
  | "common.verify"
  | "chat.greeting"
  | "chat.landing.recentChats"
  | "chat.landing.skills"
  | "chat.newChat"
  | "chat.placeholder"
  | "common.history"
  | "common.search"
  | "common.selectAMatter"
  | "guidance.notCaseLaw"
  | "lawHome.prompt"
  | "lawHome.recent"
  | "lawHome.signals"
  | "lawHome.topCourts";

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
      <InlineSkeleton className={cn("h-[0.75em]", barClassName)} />
    </span>
  );

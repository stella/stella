import { createContext, use } from "react";
import type { PropsWithChildren } from "react";

import { useTranslations } from "use-intl";

import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

// Whether the app's intl is mounted above. A pending view also renders where
// it is not (the server's cold-load paint, the locale gate), so it may not
// call `useTranslations` itself.
const PendingIntlContext = createContext(false);

/** Marks the subtree where the app's intl provider has its messages. */
export const PendingTextIntlScope = ({ children }: PropsWithChildren) => (
  <PendingIntlContext value>{children}</PendingIntlContext>
);

// The static labels pending views show. A closed union keeps the
// translator's key type small (`t` checks each one is a real message); a
// page adds its labels here as it gains a pending view.
type PendingTextKey =
  | "chat.greeting"
  | "chat.landing.recentChats"
  | "chat.landing.skills"
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
    // height inside a flex row as well as in running text.
    <span aria-hidden="true" className="inline-flex h-[1lh] items-center">
      <Skeleton className={cn("h-[0.75em]", barClassName)} />
    </span>
  );

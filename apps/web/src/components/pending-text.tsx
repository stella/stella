import { createContext, use } from "react";
import type { PropsWithChildren } from "react";

import { useTranslations } from "use-intl";

import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import type { TranslationKey } from "@/i18n/types";

// Whether the app's intl is mounted above. A pending view also renders where
// it is not (the server's cold-load paint, the locale gate), so it may not
// call `useTranslations` itself.
const PendingIntlContext = createContext(false);

/** Marks the subtree where the app's intl provider has its messages. */
export const PendingTextIntlScope = ({ children }: PropsWithChildren) => (
  <PendingIntlContext value>{children}</PendingIntlContext>
);

const TranslatedText = ({ id }: { id: TranslationKey }) => {
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
  id: TranslationKey;
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

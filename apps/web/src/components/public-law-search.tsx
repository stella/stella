import { MessageSquareTextIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";

import { ACCOUNT_GATE_OUTCOME } from "@/components/auth/require-account.logic";
import { useRequireAccount } from "@/components/auth/use-require-account";
import { openPublicLawChat } from "@/components/public-law-ask";

type PublicLawSearchProps = {
  maxLength: number;
  onQueryChange: (value: string) => void;
  /** Submitted: open what the entry names, when it names one thing. */
  onSubmit: () => void;
  placeholder: string;
  query: string;
  searchLabel: string;
  /**
   * The chat prompt for the current entry, scoped the way the page is. Null
   * hides the chat button (nothing to ask about yet).
   */
  askPrompt: (query: string) => string | null;
};

/**
 * The one box of a public-law browser: an identifier, an alias or words. A
 * form so Enter submits the way the browser already knows how to. The
 * statutes and case-law browsers share it so a reader learns one box, not
 * two; the home's entry box is built from the same parts.
 *
 * It leads its page — centred, wider and taller — because a results screen
 * has nothing above the list but this. One prominence for every browser, so
 * the two cannot drift into different pages again.
 */
export const PublicLawSearch = ({
  askPrompt,
  maxLength,
  onQueryChange,
  onSubmit,
  placeholder,
  query,
  searchLabel,
}: PublicLawSearchProps) => {
  const trimmed = query.trim();
  const prompt = trimmed.length > 0 ? askPrompt(trimmed) : null;

  return (
    <form
      className="mx-auto flex w-full max-w-2xl flex-wrap items-center justify-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      role="search"
    >
      <Input
        aria-label={searchLabel}
        className="h-11 min-h-11 min-w-64 flex-1 text-base"
        maxLength={maxLength}
        onChange={(event) => onQueryChange(event.currentTarget.value)}
        placeholder={placeholder}
        type="search"
        value={query}
      />
      {prompt !== null && (
        <PublicLawAskInChat label={trimmed} prompt={prompt} />
      )}
    </form>
  );
};

/**
 * Hands the entry to a chat with the corpus tools. Drawn for every reader; a
 * visitor is asked for an account at the moment the question would be sent,
 * and comes back to the same list.
 */
export const PublicLawAskInChat = ({
  label,
  prompt,
}: {
  label: string;
  prompt: string;
}) => {
  const t = useTranslations();
  const { accountDialog, ensureAccount } = useRequireAccount();

  return (
    <>
      <Button
        className="text-muted-foreground"
        onClick={() => {
          if (ensureAccount("askInChat") !== ACCOUNT_GATE_OUTCOME.allowed) {
            return;
          }
          openPublicLawChat({ label, prompt });
        }}
        size="sm"
        type="button"
        variant="ghost"
      >
        <MessageSquareTextIcon aria-hidden="true" className="size-3.5" />
        {t("common.askInChat")}
      </Button>
      {accountDialog}
    </>
  );
};

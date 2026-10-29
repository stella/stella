import { useTranslations } from "use-intl";

import type { ChatCorpus, ChatCorpusScope } from "@stll/api-contract";
import { isPublicCountry } from "@stll/api-contract/public-country-capability";
import { Button } from "@stll/ui/button";
import { Form } from "@stll/ui/form";
import { AiActionIcon, MessageSquareTextIcon } from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import { Loader } from "@stll/ui/loader";

import { ACCOUNT_GATE_OUTCOME } from "@/components/auth/require-account.logic";
import { useRequireAccount } from "@/components/auth/use-require-account";
import { askPublicLawInChat } from "@/components/public-law-ask";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { CapabilityAction } from "@/lib/organization/feature-access/capability-actions";

type PublicLawSearchProps = {
  maxLength: number;
  onQueryChange: (value: string) => void;
  /** Submitted: open what the entry names, when it names one thing. */
  onSubmit: () => void;
  placeholder: string;
  query: string;
  /**
   * The AI rewrite of the entry into the words the corpus uses. Omitted where
   * the surface offers none, which draws nothing.
   */
  refine?: PublicLawSearchRefine | undefined;
  searchLabel: string;
  /**
   * The corpus the page searches, which "Ask in chat" puts in front of the
   * question as a chip. Null hides the chat button (no corpus to ask in).
   */
  askScope: PublicLawAskScope | null;
};

/** The corpus a box searches, with the chip text naming it. */
export type PublicLawAskScope = {
  scope: ChatCorpusScope;
  /** Already translated: "Case law · Czechia". */
  label: string;
};

/**
 * The ask scope for a corpus and a country code in any case (`cze`, `CZE`);
 * null for a code that names no public country.
 */
export const publicLawAskScope = (
  corpus: ChatCorpus,
  countryCode: string,
  label: string,
): PublicLawAskScope | null => {
  const country = countryCode.toUpperCase();
  return isPublicCountry(country)
    ? { scope: { corpus, country }, label }
    : null;
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
  askScope,
  maxLength,
  onQueryChange,
  onSubmit,
  placeholder,
  query,
  refine,
  searchLabel,
}: PublicLawSearchProps) => {
  const trimmed = query.trim();

  return (
    <Form
      className="mx-auto max-w-2xl flex-wrap justify-center"
      density="compact"
      layout="inline"
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
      {refine !== undefined && (
        <PublicLawRefine
          disabled={trimmed.length === 0}
          isPending={refine.isPending}
          onRefine={refine.onRefine}
        />
      )}
      {askScope !== null && trimmed.length > 0 && (
        <PublicLawAskInChat askScope={askScope} question={trimmed} />
      )}
    </Form>
  );
};

export type PublicLawSearchRefine = {
  isPending: boolean;
  /** Rewrite the entry; called only once the reader may spend AI on it. */
  onRefine: () => void;
};

/**
 * The wand beside the box. Drawn for every reader, like the chat button: a
 * visitor is asked for an account when they press it, because the rewrite
 * reaches an AI endpoint.
 */
export const PublicLawRefine = ({
  disabled,
  isPending,
  labelled = false,
  onRefine,
}: PublicLawSearchRefine & {
  disabled: boolean;
  /** Spell the action out beside the wand, where it is not beside a box. */
  labelled?: boolean;
}) => {
  const t = useTranslations();
  const ensureAccount = useRequireAccount();
  const user = useMaybeAuthenticatedUser();

  return (
    <CapabilityAction
      action={{ capability: user === null ? null : "ai" }}
      surface="control"
    >
      {(capabilityProps) => (
        <Button
          aria-label={labelled ? undefined : t("search.aiRefine")}
          disabled={disabled || isPending}
          onClick={() => {
            if (ensureAccount() !== ACCOUNT_GATE_OUTCOME.allowed) {
              return;
            }
            onRefine();
          }}
          size={labelled ? "sm" : "icon-sm"}
          title={t("search.aiRefine")}
          type="button"
          variant={labelled ? "outline" : "muted"}
          {...capabilityProps}
        >
          {isPending ? (
            <Loader label={t("search.aiRefine")} size="sm" />
          ) : (
            <AiActionIcon aria-hidden="true" className="size-4" />
          )}
          {labelled && t("search.aiRefine")}
        </Button>
      )}
    </CapabilityAction>
  );
};

/**
 * Asks the entry in a chat scoped to the corpus, sent at once. Drawn for every
 * reader; a visitor is asked for an account at the moment the question would
 * be sent, and comes back to the same list.
 */
export const PublicLawAskInChat = ({
  askScope,
  question,
}: {
  askScope: PublicLawAskScope;
  question: string;
}) => {
  const t = useTranslations();
  const ensureAccount = useRequireAccount();
  const user = useMaybeAuthenticatedUser();

  return (
    <CapabilityAction
      action={{ capability: user === null ? null : "ai" }}
      surface="control"
    >
      {(capabilityProps) => (
        <Button
          className="text-muted-foreground"
          onClick={() => {
            if (ensureAccount() !== ACCOUNT_GATE_OUTCOME.allowed) {
              return;
            }
            askPublicLawInChat({
              label: question,
              question,
              scope: askScope.scope,
              scopeLabel: askScope.label,
            });
          }}
          size="sm"
          type="button"
          variant="ghost"
          {...capabilityProps}
        >
          <MessageSquareTextIcon aria-hidden="true" className="size-3.5" />
          {t("common.askInChat")}
        </Button>
      )}
    </CapabilityAction>
  );
};

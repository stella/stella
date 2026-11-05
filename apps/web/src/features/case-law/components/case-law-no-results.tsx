import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";

import {
  PublicLawAskInChat,
  PublicLawRefine,
} from "@/components/public-law-search";
import type { PublicLawAskScope } from "@/components/public-law-search";
import type { CaseLawEmptyState } from "@/features/case-law/search-warnings.logic";
import type { CaseLawRefine } from "@/features/case-law/use-case-law-refine";
import { useMountEffect } from "@/hooks/use-effect";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { useActionCapabilities } from "@/lib/organization/feature-access/capability-actions";

type CaseLawNoResultsProps = {
  askScope: PublicLawAskScope | null;
  /** What the engine said about the empty set, when it said anything. */
  reason: CaseLawEmptyState | null;
  query: string;
  refine: CaseLawRefine;
  /** Null where requiring every word is not a different search. */
  onSearchEveryWord: (() => void) | null;
};

/**
 * What a search that found nothing offers, over the table where its rows
 * would be: why there are none, and the three ways on from here. Rewrite the
 * words into the ones decisions use, ask the question in a chat that reads
 * the corpus for it, or require every word the query carries.
 */
export const CaseLawNoResults = ({
  askScope,
  reason,
  query,
  refine,
  onSearchEveryWord,
}: CaseLawNoResultsProps) => {
  const t = useTranslations();
  const question = query.trim();

  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">
          {reason === null ? t("common.noResults") : t(reason.messageKey)}
        </p>
        <p className="text-foreground-strong-muted text-xs">
          {reason === null ? t("caseLaw.noResults.hint") : t(reason.hintKey)}
        </p>
      </div>
      {question.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <PublicLawRefine
            disabled={false}
            isPending={refine.isPending}
            labelled
            onRefine={refine.onRefine}
          />
          {askScope !== null && (
            <PublicLawAskInChat askScope={askScope} question={question} />
          )}
          {onSearchEveryWord !== null && (
            <Button
              onClick={onSearchEveryWord}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("caseLaw.searchWarnings.searchEveryWord")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Runs the rewrite once, for a signed-in reader whose organization has AI.
 * Mounted by the page only while `shouldAutoRewrite` holds, keyed by the
 * search, so each search that qualifies is rewritten at most once and a
 * public reader is never spent on.
 */
export const CaseLawAutoRewrite = ({
  onAutoRefine,
}: {
  onAutoRefine: () => void;
}) => {
  const user = useMaybeAuthenticatedUser();
  return user === null ? null : (
    <AutoRewriteWhenAiAvailable onAutoRefine={onAutoRefine} />
  );
};

const AutoRewriteWhenAiAvailable = ({
  onAutoRefine,
}: {
  onAutoRefine: () => void;
}) => {
  const { capabilities } = useActionCapabilities("ai");
  return capabilities.ai.type === "available" ? (
    <RunOnce run={onAutoRefine} />
  ) : null;
};

const RunOnce = ({ run }: { run: () => void }) => {
  useMountEffect(() => {
    run();
  });
  return null;
};

type RewrittenSearchLineProps = {
  /** The words the reader typed. */
  original: string;
  /** The words the results answer. */
  rewritten: string;
  onSearchOriginal: () => void;
};

/**
 * Says the page rewrote the search, on the count's line: the results below
 * answer other words than the ones the reader typed, and one press goes back
 * to those.
 */
export const RewrittenSearchLine = ({
  original,
  rewritten,
  onSearchOriginal,
}: RewrittenSearchLineProps) => {
  const t = useTranslations();

  return (
    <div className="text-muted-foreground flex max-w-full min-w-0 flex-wrap items-baseline gap-x-2 text-xs">
      <Tooltip>
        <TooltipTrigger render={<p className="min-w-0 truncate" />}>
          {t.rich("caseLaw.rewritten.line", {
            bdi: (chunks) => <BidiText>{chunks}</BidiText>,
            original,
            query: rewritten,
          })}
        </TooltipTrigger>
        <TooltipPopup>
          <BidiText>{rewritten}</BidiText>
        </TooltipPopup>
      </Tooltip>
      <Button onClick={onSearchOriginal} size="xs" variant="link">
        {t("caseLaw.rewritten.searchOriginal")}
      </Button>
    </div>
  );
};

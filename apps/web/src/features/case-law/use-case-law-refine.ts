import { useMutation } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { refineOutcome } from "@/features/case-law/case-law-empty-results.logic";
import { fromCaseLawCountryParam } from "@/features/case-law/case-law-jurisdiction";
import { refineCaseLawQuery } from "@/features/case-law/queries/decisions";
import { useI18nStore } from "@/i18n/i18n-store";
import { useAnalytics } from "@/lib/analytics/provider";
import { notifyUserError } from "@/lib/errors/user-toast";

type CaseLawRefineOptions = {
  /** The jurisdiction the page is scoped to, as a country param. */
  country: string;
  /** What the box holds now: a rewrite of anything else is stale. */
  query: string;
  /** The search requires every word: a choice a late rewrite must not undo. */
  strict: boolean;
  /** A rewrite the reader asked for landed: search for it. */
  onRefined: (refined: string) => void;
  /**
   * A rewrite the page asked for on its own landed: search for it and say
   * so. Its failure stays quiet; the empty results already say what to do.
   */
  onAutoRefined: (refined: string, original: string) => void;
};

/**
 * The AI rewrite of a case-law entry into the words the jurisdiction's
 * decisions use ("kauce" becomes "jistota"): the wand beside the box, the
 * same action on the empty results, and the one the page runs by itself when
 * a question found nothing. One mutation, so they cannot run twice at once.
 */
export const useCaseLawRefine = ({
  country,
  query,
  strict,
  onRefined,
  onAutoRefined,
}: CaseLawRefineOptions) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const locale = useI18nStore((state) => state.loadedLang);
  const mutation = useMutation({
    mutationFn: async (asked: {
      country: string;
      strict: boolean;
      entry: string;
      automatic: boolean;
    }) =>
      await refineCaseLawQuery({
        country: fromCaseLawCountryParam(asked.country),
        locale,
        query: asked.entry,
      }),
    onSuccess: (refined, asked) => {
      const outcome = refineOutcome({
        asked,
        current: { country, query, strict },
        refined: refined.query,
      });
      switch (outcome) {
        case "stale":
        case "unchanged":
          return;
        case "automatic":
          onAutoRefined(refined.query, asked.entry);
          return;
        case "manual":
          onRefined(refined.query);
          return;
        default:
          outcome satisfies never;
          panic(`Unhandled refine outcome: ${String(outcome)}`);
      }
    },
    onError: (error, asked) => {
      analytics.captureError(error, {
        fingerprintKey: "CaseLawSearch:failure",
        scope: { type: "handler", handlerId: "CaseLawSearch:failure" },
      });
      if (!asked.automatic) {
        notifyUserError(error, t("common.somethingWentWrong"));
      }
    },
  });

  const run = (automatic: boolean) => {
    if (mutation.isPending) {
      return;
    }
    mutation.mutate({ country, entry: query.trim(), strict, automatic });
  };

  return {
    isPending: mutation.isPending,
    /** The reader asked for the rewrite. */
    onRefine: () => run(false),
    /** The page asks for it on its own, after a question found nothing. */
    onAutoRefine: () => run(true),
  };
};

export type CaseLawRefine = ReturnType<typeof useCaseLawRefine>;

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

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
  onRefined,
  onAutoRefined,
}: CaseLawRefineOptions) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const locale = useI18nStore((state) => state.loadedLang);
  const mutation = useMutation({
    mutationFn: async (asked: {
      country: string;
      entry: string;
      automatic: boolean;
    }) =>
      await refineCaseLawQuery({
        country: fromCaseLawCountryParam(asked.country),
        locale,
        query: asked.entry,
      }),
    // The box stays editable while the model answers. A rewrite of an entry
    // the reader has since changed, or of another jurisdiction, is dropped
    // rather than written over what they typed. A rewrite that says the same
    // words would search the same nothing again.
    onSuccess: (refined, asked) => {
      if (
        asked.entry !== query.trim() ||
        asked.country !== country ||
        refined.query.trim() === asked.entry
      ) {
        return;
      }
      if (asked.automatic) {
        onAutoRefined(refined.query, asked.entry);
        return;
      }
      onRefined(refined.query);
    },
    onError: (error, asked) => {
      analytics.captureError(error);
      if (!asked.automatic) {
        notifyUserError(error, t("common.somethingWentWrong"));
      }
    },
  });

  const run = (automatic: boolean) => {
    if (mutation.isPending) {
      return;
    }
    mutation.mutate({ country, entry: query.trim(), automatic });
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

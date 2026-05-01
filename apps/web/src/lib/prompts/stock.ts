import { useMemo } from "react";

import { useTranslations } from "use-intl";

import type { ChatPrompt } from "@/lib/prompts/types";

/**
 * Curated stock prompts bundled with the product. The set stays
 * small on purpose — these are starting points, not a library.
 * User-saved prompts (team and private) join the same picker via
 * the Stage 3 API and show alongside this list.
 */
export const useStockPrompts = (): ChatPrompt[] => {
  const t = useTranslations();
  return useMemo<ChatPrompt[]>(
    () => [
      {
        id: "summarize-document",
        scope: "stock",
        name: t("chat.prompts.stock.summarizeDocument.name"),
        body: t("chat.prompts.stock.summarizeDocument.body"),
      },
      {
        id: "find-risks",
        scope: "stock",
        name: t("chat.prompts.stock.findRisks.name"),
        body: t("chat.prompts.stock.findRisks.body"),
      },
      {
        id: "compare-versions",
        scope: "stock",
        name: t("chat.prompts.stock.compareVersions.name"),
        body: t("chat.prompts.stock.compareVersions.body"),
      },
      {
        id: "draft-response",
        scope: "stock",
        name: t("chat.prompts.stock.draftResponse.name"),
        body: t("chat.prompts.stock.draftResponse.body"),
      },
    ],
    [t],
  );
};

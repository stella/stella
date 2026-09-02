import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import Tooltip from "@/components/tooltip";
import { caseLawCorpusStatusOptions } from "@/features/case-law/queries/decisions";
import { useFormatter } from "@/i18n/formatting-context";
import { formatFullTimestamp } from "@/lib/relative-time";

/**
 * The corpus's freshness, where the chat's status row keeps its meter: a
 * green dot and one word, with the count and the last update on hover.
 * Nothing is shown until the status is known; a dot that cannot say when
 * would be a decoration.
 */
export const LawDatabaseStatus = () => {
  const t = useTranslations();
  const format = useFormatter();
  const { data: status } = useQuery(caseLawCorpusStatusOptions());

  const updatedAt = status?.updatedAt ?? null;
  if (status === undefined || updatedAt === null) {
    return null;
  }

  return (
    <Tooltip
      content={t("lawHome.databaseStatus", {
        count: format.number(status.decisions),
        date: formatFullTimestamp(updatedAt),
      })}
      render={
        <span className="inline-flex cursor-default items-center gap-1.5 text-[11px]" />
      }
      side="top"
    >
      <span aria-hidden="true" className="bg-success size-1.5 rounded-full" />
      {t("lawHome.databaseUpToDate")}
    </Tooltip>
  );
};

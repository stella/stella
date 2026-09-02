import { useTranslations } from "use-intl";

import Tooltip from "@/components/tooltip";
import { useFormatter } from "@/i18n/formatting-context";
import { parseDeterministicDate } from "@/lib/deterministic-date";
import { PLACEHOLDER_DATABASE_STATUS } from "@/routes/law/-law-home/law-home-placeholders";

/**
 * The corpus's freshness, where the chat's status row keeps its meter: a
 * green dot and one word, with the count and the last update on hover.
 */
export const LawDatabaseStatus = () => {
  const t = useTranslations();
  const format = useFormatter();
  const updatedAt = parseDeterministicDate(
    PLACEHOLDER_DATABASE_STATUS.updatedAt,
  );

  return (
    <Tooltip
      content={t("lawHome.databaseStatus", {
        count: format.number(PLACEHOLDER_DATABASE_STATUS.entries),
        date:
          updatedAt === null
            ? PLACEHOLDER_DATABASE_STATUS.updatedAt
            : format.dateTime(updatedAt, {
                dateStyle: "medium",
                timeStyle: "short",
              }),
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

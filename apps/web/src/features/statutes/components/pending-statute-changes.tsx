import { useTranslations } from "use-intl";

import { sanitizeHref } from "@stll/decision-reader/sanitize-href";

import type { PublicStatute } from "@/features/statutes/queries/statutes";
import { useFormatter } from "@/i18n/formatting-context";
import { formatValidityDate } from "@/lib/statutes/statute-format";

import { resolveAmendmentHref } from "./pending-statute-changes.logic";

type PendingStatuteChangesProps = {
  changes: PublicStatute["pendingChanges"];
};

export const PendingStatuteChanges = ({
  changes,
}: PendingStatuteChangesProps) => {
  const t = useTranslations();
  const formatter = useFormatter();

  if (changes === null) {
    return null;
  }
  if (changes.items.length === 0 && changes.coverage.type === "complete") {
    return null;
  }

  const amendmentStarts = new Map(
    changes.items.map((change) => [
      JSON.stringify([
        change.amendingEli,
        change.effectiveDate,
        change.effectiveText,
      ]),
      change,
    ]),
  );

  const incomplete =
    changes.coverage.type !== "complete" ||
    changes.truncated ||
    changes.items.some((change) => change.effectiveDate === null);

  return (
    <aside className="mx-6 space-y-2 border-y py-3 text-sm">
      <h2 className="font-medium">{t("statutes.pendingChanges")}</h2>
      <ul className="space-y-1">
        {Array.from(amendmentStarts.values(), (change) => {
          const href = resolveAmendmentHref(change.amendingEli);
          const label = <bdi>{change.amendingTitle ?? change.amendingEli}</bdi>;
          return (
            <li key={change.publisherId}>
              {href === undefined ? (
                label
              ) : (
                <a
                  className="underline underline-offset-4"
                  href={sanitizeHref(href)}
                  target={href.startsWith("/") ? undefined : "_blank"}
                  rel="noreferrer"
                >
                  {label}
                </a>
              )}
              {change.effectiveText !== null && (
                <>
                  {" · "}
                  <bdi>{change.effectiveText}</bdi>
                </>
              )}
              {change.effectiveDate !== null && (
                <>
                  {" · "}
                  <time dateTime={change.effectiveDate}>
                    {formatValidityDate(change.effectiveDate, formatter) ??
                      change.effectiveDate}
                  </time>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {incomplete && (
        <p className="text-muted-foreground">
          {t("statutes.pendingChangesIncomplete")}
        </p>
      )}
    </aside>
  );
};

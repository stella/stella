import type { ReactNode } from "react";

import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import { StatuteStatusPill } from "@/features/statutes/components/statute-status-pill";
import {
  EM_DASH,
  formatValidityDate,
} from "@/features/statutes/statute-format";
import { useFormatter } from "@/i18n/formatting-context";
import { toStatuteCountrySegment } from "@/lib/statute-route";

export type StatuteListItem = {
  country: string;
  documentType: string | null;
  effectiveDate: string | null;
  id: string;
  status: string;
  title: string;
  versionValidFrom: string | null;
};

/**
 * One entry of the statutes list: the title a lawyer recognises the act by,
 * then its lifecycle and when the current wording took effect. The loading
 * row below renders the same shell, so the list cannot shift when data lands.
 */
export const StatuteListRow = ({ statute }: { statute: StatuteListItem }) => {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <RowShell
      meta={
        <>
          <StatuteStatusPill status={statute.status} />
          {statute.documentType !== null && <span>{statute.documentType}</span>}
          <span>
            {t("statutes.inForceSince", {
              date:
                formatValidityDate(statute.versionValidFrom, format) ??
                formatValidityDate(statute.effectiveDate, format) ??
                EM_DASH,
            })}
          </span>
        </>
      }
      title={statute.title}
      to={{
        country: toStatuteCountrySegment(statute.country),
        documentId: statute.id,
      }}
    />
  );
};

export const StatuteListRowSkeleton = () => (
  <RowShell
    meta={
      <>
        <Skeleton className="h-4 w-14" />
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-32" />
      </>
    }
    title={<Skeleton className="h-5 w-3/5" />}
    to={null}
  />
);

const ROW_CLASS = "block rounded-md border px-4 py-3";

const RowShell = ({
  meta,
  title,
  to,
}: {
  meta: ReactNode;
  title: ReactNode;
  to: { country: string; documentId: string } | null;
}) => {
  // Block containers: the loading row puts block skeletons here, and a block
  // inside an inline element is markup the browser would reparse, which a
  // server-rendered public page then fails to hydrate.
  const body = (
    <>
      <div className="text-foreground font-medium">{title}</div>
      <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {meta}
      </div>
    </>
  );

  if (to === null) {
    return <div className={ROW_CLASS}>{body}</div>;
  }

  return (
    <Link
      className={cn(ROW_CLASS, "hover:bg-muted/50 transition-colors")}
      params={to}
      to="/law/$country/statutes/$documentId"
    >
      {body}
    </Link>
  );
};

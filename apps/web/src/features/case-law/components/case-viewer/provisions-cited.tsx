import { useState } from "react";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { panic } from "better-result";
import { ChevronRightIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { cn } from "@stll/ui/lib/utils";

import type {
  ProvisionReference,
  RenderProvisionPart,
} from "@/features/case-law/provision-label";
import { formatProvisionReference } from "@/features/case-law/provision-label";
import {
  decisionProvisionsInfiniteOptions,
  statuteByEliOptions,
  statuteVersionsOptions,
} from "@/features/case-law/queries/provisions";
import {
  pickVersionAt,
  versionCoversDate,
} from "@/features/case-law/statute-version";
import { optionalArray } from "@/lib/arrays";
import { detached } from "@/lib/detached";
import type { SafeId } from "@/lib/safe-id";
import { toStatuteCountrySegment } from "@/lib/statute-route";

/**
 * Works whose act is looked up when the panel opens. A reference names its
 * work by identifier, while the statute reader is addressed by document, so
 * each distinct work costs one read; past this many the references still
 * read, they just do not link.
 */
const LINKED_WORKS_LIMIT = 12;

type ProvisionRow = ProvisionReference & {
  anchor: string;
  jurisdiction: string;
  /** Where in the decision the reference stands; two can share an anchor. */
  spanStart: number;
  /** Opening date of the consolidation the reference was made against. */
  versionValidFrom: string | null;
  workCollection: string;
  workEli: string | null;
  workIdentifier: string;
};

type WorkGroup = {
  key: string;
  rows: ProvisionRow[];
  title: string;
} & Pick<ProvisionRow, "jurisdiction" | "workEli">;

const groupByWork = (rows: readonly ProvisionRow[]): WorkGroup[] => {
  const groups = new Map<string, WorkGroup>();

  for (const row of rows) {
    const key = `${row.jurisdiction}/${row.workIdentifier}`;
    const group = groups.get(key);

    if (group === undefined) {
      groups.set(key, {
        jurisdiction: row.jurisdiction,
        key,
        rows: [row],
        title: `${row.workIdentifier} ${row.workCollection}`.trim(),
        workEli: row.workEli,
      });
      continue;
    }

    group.rows.push(row);
  }

  return [...groups.values()];
};

/**
 * The statutes a decision applies, as the decision itself states them.
 *
 * Closed until asked for: the references are a reading aid beside the
 * decision, and resolving each cited work to its act costs a read per work.
 */
export const ProvisionsCited = ({
  decisionId,
}: {
  decisionId: SafeId<"caseLawDecision">;
}) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);

  /**
   * The catalog's word for each named subdivision. A switch rather than a key
   * map, so every branch names a literal message and a subdivision the corpus
   * starts recording fails the exhaustiveness check instead of reaching the
   * page unnamed.
   */
  const renderPart: RenderProvisionPart = (key, value) => {
    switch (key) {
      case "article": {
        return t("caseLaw.provision.article", { value });
      }
      case "letter": {
        return t("caseLaw.provision.letter", { value });
      }
      case "openEnded": {
        return t("caseLaw.provision.openEnded");
      }
      case "point": {
        return t("caseLaw.provision.point", { value });
      }
      case "sentence": {
        return t("caseLaw.provision.sentence", { value });
      }
      case "subsection": {
        return t("caseLaw.provision.subsection", { value });
      }
      default: {
        const unreachable: never = key;
        return panic("Unnamed provision subdivision", unreachable);
      }
    }
  };

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetchingNextPage,
    refetch,
  } = useInfiniteQuery(decisionProvisionsInfiniteOptions(decisionId));

  const groups = groupByWork(
    optionalArray(data?.pages).flatMap((page) => page.items),
  );

  // Absent is the answer for a decision that applies no provisions. A failed
  // read is not that answer, so it keeps the panel and says so instead of
  // disappearing as though the decision cited nothing.
  if (groups.length === 0 && !isError) {
    return null;
  }

  return (
    <section className="border-border/60 mb-6 rounded-lg border font-sans print:hidden">
      <button
        aria-expanded={open}
        className="text-foreground-strong-muted hover:text-foreground flex w-full items-center gap-1.5 px-3 py-2 text-start text-xs font-medium"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <ChevronRightIcon
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        {t("caseLaw.viewer.provisionsCited")}
      </button>
      {open && (
        <div className="flex flex-col gap-3 px-3 pb-3">
          {isError && (
            <div className="flex items-center gap-2">
              <p className="text-muted-foreground text-xs">
                {t("errors.actionFailed")}
              </p>
              <Button
                className="text-xs"
                onClick={() => {
                  detached(refetch(), "case-law.provisions-retry");
                }}
                size="sm"
                variant="ghost"
              >
                {t("common.retry")}
              </Button>
            </div>
          )}
          {groups.map((group, index) => (
            <WorkReferences
              group={group}
              isLinked={index < LINKED_WORKS_LIMIT}
              key={group.key}
              renderPart={renderPart}
            />
          ))}
          {hasNextPage && (
            <Button
              className="w-fit text-xs"
              disabled={isFetchingNextPage}
              onClick={() => {
                detached(fetchNextPage(), "case-law.provisions-more");
              }}
              size="sm"
              variant="ghost"
            >
              {t("common.loadMore")}
            </Button>
          )}
        </div>
      )}
    </section>
  );
};

const WorkReferences = ({
  group,
  isLinked,
  renderPart,
}: {
  group: WorkGroup;
  isLinked: boolean;
  renderPart: RenderProvisionPart;
}) => {
  const { data: statute } = useQuery({
    ...statuteByEliOptions({
      country: group.jurisdiction,
      eli: group.workEli ?? "",
    }),
    enabled: isLinked && group.workEli !== null,
  });

  // A reference to wording the current consolidation still carries is
  // answered by the document already resolved; only a citation reaching
  // further back needs the work's other versions.
  const needsVersions =
    statute !== undefined &&
    statute !== null &&
    group.rows.some(
      (row) =>
        row.versionValidFrom !== null &&
        !versionCoversDate(statute, row.versionValidFrom),
    );

  const { data: versions } = useQuery({
    ...statuteVersionsOptions(statute?.id ?? ""),
    enabled: needsVersions,
  });

  /** The consolidation a reference was made against, current wording last. */
  const documentFor = (row: ProvisionRow) => {
    if (statute === undefined || statute === null) {
      return null;
    }

    if (row.versionValidFrom === null) {
      return statute;
    }

    return (
      pickVersionAt(optionalArray(versions), row.versionValidFrom) ?? statute
    );
  };

  return (
    <div className="flex flex-col gap-1">
      <p className="text-muted-foreground text-[0.7rem] tracking-wide uppercase">
        {group.title}
      </p>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {group.rows.map((row) => {
          const label = formatProvisionReference(row, renderPart);
          const key = `${row.anchor}-${row.spanStart}`;
          const document = documentFor(row);

          if (document === null) {
            return (
              <li className="text-foreground-strong-muted text-xs" key={key}>
                {label}
              </li>
            );
          }

          return (
            <li key={key}>
              <Link
                className="text-primary text-xs hover:underline"
                hash={row.anchor}
                params={{
                  country: toStatuteCountrySegment(document.country),
                  documentId: document.id,
                }}
                to="/law/$country/statutes/$documentId"
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

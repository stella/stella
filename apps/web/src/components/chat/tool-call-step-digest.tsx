import type { ReactElement } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { ChatStepFilter } from "@stll/api-contract/chat-step-ledger";
import { BidiText } from "@stll/ui/bidi-text";
import { DocumentIdentityBadge } from "@stll/ui/document-identity-badge";
import { CircleOffIcon, SearchIcon } from "@stll/ui/icons";
import { MatterIcon } from "@stll/ui/matter-icon";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import { LegalCitationLink } from "@/components/chat/legal-citation-link";
import type {
  StepDigest,
  StepDigestCall,
  StepDigestCounts,
  StepDigestRow,
  StepMatterReference,
} from "@/components/chat/tool-call-step-digest.logic";
import {
  ReferenceChip,
  useReferenceAvailability,
} from "@/components/references/reference-chip";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { statuteDocumentIdentity } from "@/lib/legal/statute-act-number";

/**
 * An opened step as a person reads it: what it searched, with its filters,
 * and what came back, each found decision or provision opening where an
 * inline citation opens it. No code and no raw result.
 */
export const ToolCallStepDigest = ({ digest }: { digest: StepDigest }) => {
  const t = useTranslations("chat.stepDigest");
  return (
    <div className="space-y-2" data-step-digest>
      <StepDigestCountsLine counts={digest.counts} />
      <ul className="space-y-2.5">
        {digest.calls.map((call) => (
          <StepDigestCallView
            call={call}
            key={call.key}
            recorded={digest.recorded}
          />
        ))}
      </ul>
      {digest.callsOmitted > 0 && (
        <p className="text-foreground-ghost text-xs">
          {t("moreLookups", { count: digest.callsOmitted })}
        </p>
      )}
    </div>
  );
};

const StepDigestCountsLine = ({ counts }: { counts: StepDigestCounts }) => {
  const t = useTranslations("chat.stepDigest");
  const tCount = useTranslations("workspaces");
  const parts = [
    ...(counts.decisions > 0
      ? [
          counts.decisionsCited > 0
            ? t("decisionsFoundUsed", {
                found: counts.decisions,
                used: counts.decisionsCited,
              })
            : t("decisionsFound", { found: counts.decisions }),
        ]
      : []),
    ...(counts.legislation > 0
      ? [t("legislationFound", { count: counts.legislation })]
      : []),
    ...(counts.documents > 0
      ? [tCount("documentsCount", { count: counts.documents })]
      : []),
    ...(counts.matters > 0
      ? [tCount("mattersCount", { count: counts.matters })]
      : []),
  ];
  if (parts.length === 0) {
    return null;
  }
  return (
    <p className="text-muted-foreground text-xs tabular-nums">
      {parts.join(" · ")}
    </p>
  );
};

const StepDigestCallView = ({
  call,
  recorded,
}: {
  call: StepDigestCall;
  recorded: boolean;
}) => {
  const t = useTranslations("chat.stepDigest");
  // A read that searched for nothing and named nothing (a list of tasks, a
  // usage figure) has nothing a person would read here.
  if (
    call.queries.length === 0 &&
    call.rows.length === 0 &&
    call.omitted === 0 &&
    call.outcome === "ok"
  ) {
    return null;
  }
  return (
    <li className="min-w-0 space-y-1">
      {call.queries.map((query) => (
        <p
          className="text-foreground flex min-w-0 items-start gap-1.5 text-xs leading-5"
          key={query}
        >
          <SearchIcon
            aria-hidden="true"
            className="text-foreground-ghost mt-1 size-3 shrink-0"
          />
          <TruncatedText
            className="min-w-0 text-pretty"
            lines={2}
            render={<BidiText as="span" />}
          >
            {query}
          </TruncatedText>
        </p>
      ))}
      {call.filters.length > 0 && (
        <div className="flex flex-wrap gap-1 ps-4.5">
          {call.filters.map((filter) => (
            <StepFilterChip
              filter={filter}
              key={`${filter.kind}:${filter.value}`}
            />
          ))}
        </div>
      )}
      {call.outcome === "error" && (
        // A lookup that did not go through is part of the work, not an
        // alarm: it reads in the same quiet tone as one that matched nothing.
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <CircleOffIcon
            aria-hidden="true"
            className="text-foreground-ghost size-3 shrink-0"
          />
          {t("lookupDidNotGoThrough")}
        </p>
      )}
      {recorded &&
        call.outcome === "ok" &&
        call.rows.length === 0 &&
        call.queries.length > 0 && (
          <p className="text-muted-foreground ps-4.5 text-xs">
            {t("nothingFound")}
          </p>
        )}
      {call.rows.length > 0 && (
        <ul
          className={cn(
            "min-w-0 space-y-1",
            call.queries.length > 0 && "ps-4.5",
          )}
        >
          {call.rows.map((row) => (
            <StepDigestRowView key={row.key} row={row} />
          ))}
        </ul>
      )}
      {call.omitted > 0 && (
        <p className="text-foreground-ghost ps-4.5 text-xs">
          {t("moreFound", { count: call.omitted })}
        </p>
      )}
    </li>
  );
};

// A date range reads the way the matter filters word it.
// Any other filter shows its value as given (a country, a court).
const DATED_FILTER_KEYS = {
  asOf: "chat.stepDigest.filterAsOf",
  country: null,
  court: null,
  dateFrom: "workspaces.filters.date.from",
  dateTo: "workspaces.filters.date.to",
  decisionType: null,
  documentType: null,
  language: null,
  status: null,
} as const satisfies Record<ChatStepFilter["kind"], TranslationKey | null>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/u;

const StepFilterChip = ({ filter }: { filter: ChatStepFilter }) => {
  const t = useTranslations();
  const format = useFormatter();
  const date = (value: string) =>
    ISO_DATE.test(value)
      ? format.dateTime(new Date(value.slice(0, 10)), {
          dateStyle: "medium",
          timeZone: "UTC",
        })
      : value;
  const datedKey = DATED_FILTER_KEYS[filter.kind];
  const label =
    datedKey === null
      ? filter.value
      : t(datedKey, { date: date(filter.value) });
  return (
    <span className="bg-muted text-muted-foreground text-2xs inline-flex max-w-full items-center rounded-sm px-1.5 py-px leading-4">
      <TruncatedText render={<BidiText as="span" />}>{label}</TruncatedText>
    </span>
  );
};

const StepDigestRowView = ({ row }: { row: StepDigestRow }) => {
  const t = useTranslations("chat.stepDigest");
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs leading-5">
      <StepRefLabel row={row} />
      {row.cited && (
        <span className="text-foreground-ghost text-2xs shrink-0">
          {t("usedInAnswer")}
        </span>
      )}
    </li>
  );
};

const StepRefLabel = ({ row }: { row: StepDigestRow }) => {
  const t = useTranslations("chat.stepDigest");
  const format = useFormatter();
  const { ref, source } = row;
  const formatDate = (value: string | null) =>
    value === null
      ? null
      : format.dateTime(new Date(value), {
          dateStyle: "medium",
          timeZone: "UTC",
        });
  switch (ref.type) {
    case "decision": {
      const date = formatDate(ref.decisionDate);
      // The citation chip's anatomy: the court's identity badge, then the
      // case number and date; the decision's one line follows it, quiet.
      const label = (
        <TruncatedText className="font-medium" render={<BidiText as="span" />}>
          {ref.caseNumber}
          {date === null ? "" : ` · ${date}`}
        </TruncatedText>
      );
      return (
        <>
          <DocumentIdentityBadge
            identity={{
              kind: "decision",
              courtAbbreviation:
                source?.caseLaw?.courtShortCode ?? ref.courtAbbreviation,
              courtTier: source?.caseLaw?.tier,
            }}
            size="inline"
            title={ref.court}
          />
          {source === null ? (
            label
          ) : (
            <LegalCitationLink
              appearance="tray"
              fullTrayLabel
              interactive
              linkIconSource={{ kind: "tool-source" }}
              source={source}
            >
              {label}
            </LegalCitationLink>
          )}
          {ref.summary !== null && (
            <TruncatedText
              className="text-muted-foreground min-w-32 flex-1"
              render={<BidiText as="span" />}
            >
              {ref.summary}
            </TruncatedText>
          )}
        </>
      );
    }
    case "statute": {
      const validFrom = formatDate(ref.validFrom);
      return (
        <>
          <DocumentIdentityBadge
            identity={statuteDocumentIdentity(ref.eli)}
            size="inline"
          />
          {source === null ? (
            <BidiText as="span" className="font-medium">
              {ref.label}
            </BidiText>
          ) : (
            <LegalCitationLink
              appearance="tray"
              interactive
              linkIconSource={{ kind: "tool-source" }}
              source={source}
            >
              {ref.label}
            </LegalCitationLink>
          )}
          {validFrom !== null && (
            <span className="text-muted-foreground shrink-0">
              {t("versionFrom", { date: validFrom })}
            </span>
          )}
        </>
      );
    }
    case "document":
    case "matter": {
      const title = <StepMatterTitle type={ref.type} title={ref.title} />;
      return row.reference === null ? (
        title
      ) : (
        <StepMatterReferenceLink fallback={title} reference={row.reference} />
      );
    }
    default:
      ref satisfies never;
      return panic("Unhandled step ledger item");
  }
};

/** A matter item by its title alone, for one that opens nowhere. */
const StepMatterTitle = ({
  title,
  type,
}: {
  title: string;
  type: "document" | "matter";
}) => (
  <span className="text-foreground flex min-w-0 items-center gap-1.5">
    {type === "document" ? (
      <DocumentIdentityBadge identity={{ kind: "unknown" }} />
    ) : (
      <MatterIcon
        className="text-muted-foreground size-3.5 shrink-0"
        variant="none"
      />
    )}
    <TruncatedText render={<BidiText as="span" />}>{title}</TruncatedText>
  </span>
);

/**
 * A found document or matter, opening where a mention of it in chat opens
 * (`ReferenceChip`), once the viewer's own read of it says they may; while
 * that read is out, or when it says they may not, the title alone, as the
 * step already showed it.
 */
const StepMatterReferenceLink = ({
  fallback,
  reference,
}: {
  fallback: ReactElement;
  reference: StepMatterReference;
}) =>
  useReferenceAvailability(reference) === "resolved" ? (
    <ReferenceChip interactive reference={reference} />
  ) : (
    fallback
  );

/** The line an opened code step shows when it kept no ledger. */
export const STEP_DIGEST_NOT_RECORDED_KEY =
  "chat.stepDigest.notRecorded" as const satisfies TranslationKey;

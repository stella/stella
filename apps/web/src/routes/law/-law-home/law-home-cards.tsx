import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";

import {
  decisionLinkElement,
  formatDecisionDate,
} from "@/features/case-law/components/decision-cells";
import type { LatestDecisionsCourt } from "@/features/case-law/queries/decisions";
import { researchTablesInfiniteOptions } from "@/features/case-law/research/queries";
import type { LegislationShelfItem } from "@/features/statutes/queries/statutes";
import { formatValidityDate } from "@/features/statutes/statute-format";
import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { createCaseLawDecisionRouteParams } from "@/lib/case-law-route";
import { parseDeterministicDate } from "@/lib/deterministic-date";
import type { StatuteCountry } from "@/lib/statute-route";
import {
  LAW_HOME_SHOW_ALL_CLASS,
  LawHomeCard,
  LawHomeRow,
  LawHomeRowList,
} from "@/routes/law/-law-home/law-home-card";

/** Rows per card: a sample the reader scans, not a list they work through. */
const ROWS_PER_CARD = 3;
const RESEARCH_TABLES_PER_CARD = 5;

/** The seeded rank labels the shelf reports, as the words a reader knows. */
const TIER_LABEL_KEYS = {
  constitutional: "lawHome.tier.constitutional",
  supreme: "lawHome.tier.supreme",
} as const satisfies Record<"constitutional" | "supreme", TranslationKey>;

const isKnownTier = (value: string): value is keyof typeof TIER_LABEL_KEYS =>
  Object.hasOwn(TIER_LABEL_KEYS, value);

type TopCourtCardProps = {
  /** The pill's value, so "show all" keeps the reader's scope. */
  countryParam: string;
  group: LatestDecisionsCourt;
};

/** The newest decisions of one apex court. */
export const TopCourtCard = ({ countryParam, group }: TopCourtCardProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const decisions = group.decisions.slice(0, ROWS_PER_CARD);

  if (decisions.length === 0) {
    return null;
  }

  return (
    <LawHomeCard
      heading={t("lawHome.topCourts")}
      showAll={
        <Link
          className={LAW_HOME_SHOW_ALL_CLASS}
          search={{ country: countryParam, court: group.court }}
          to="/law/cases"
        >
          {t("common.showAll")}
        </Link>
      }
      tag={
        isKnownTier(group.tierLabel)
          ? t(TIER_LABEL_KEYS[group.tierLabel])
          : null
      }
      title={group.court}
    >
      <LawHomeRowList>
        {decisions.map((decision) => (
          <LawHomeRow
            key={decision.id}
            line={decision.headnote}
            meta={
              decision.decisionDate === null
                ? null
                : formatDecisionDate(decision.decisionDate, format)
            }
            title={decisionLinkElement(
              createCaseLawDecisionRouteParams({
                caseNumber: decision.caseNumber,
                country: decision.country,
                court: decision.court,
                decisionId: decision.id,
                language: decision.language,
                languageAlternates: decision.languageAlternates,
                slug: decision.slug,
              }),
              "text-foreground font-medium hover:underline",
              <BidiText>{decision.caseNumber}</BidiText>,
            )}
          />
        ))}
      </LawHomeRowList>
    </LawHomeCard>
  );
};

/** Which side of the shelf a card shows, and therefore how its dates read. */
export type LegislationShelfKind = "enteringIntoForce" | "recentlyInForce";

const SHELF_HEADING_KEYS = {
  enteringIntoForce: "lawHome.enteringIntoForce",
  recentlyInForce: "lawHome.recentlyInForce",
} as const satisfies Record<LegislationShelfKind, TranslationKey>;

type LegislationShelfCardProps = {
  country: StatuteCountry;
  items: readonly LegislationShelfItem[];
  kind: LegislationShelfKind;
};

/** One side of the legislation shelf: recently in force, or coming into force. */
export const LegislationShelfCard = ({
  country,
  items,
  kind,
}: LegislationShelfCardProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const shown = items.slice(0, ROWS_PER_CARD);

  if (shown.length === 0) {
    return null;
  }

  const validityLine = (date: string): string =>
    kind === "recentlyInForce"
      ? t("statutes.inForceSince", { date })
      : t("lawHome.inForceFrom", { date });

  return (
    <LawHomeCard
      heading={t(SHELF_HEADING_KEYS[kind])}
      showAll={
        <Link
          className={LAW_HOME_SHOW_ALL_CLASS}
          params={{ country }}
          to="/law/$country/statutes"
        >
          {t("common.showAll")}
        </Link>
      }
    >
      <LawHomeRowList>
        {shown.map((item) => {
          const date = formatValidityDate(item.versionValidFrom, format);
          return (
            <LawHomeRow
              key={item.id}
              line={date === null ? null : validityLine(date)}
              title={
                <Link
                  className="text-foreground font-medium hover:underline"
                  params={{ country, documentId: item.id }}
                  to="/law/$country/statutes/$documentId"
                >
                  <BidiText>{item.title}</BidiText>
                </Link>
              }
            />
          );
        })}
      </LawHomeRowList>
    </LawHomeCard>
  );
};

type IdentifierExamplesCardProps = {
  examples: readonly string[];
  onExampleSelect: (example: string) => void;
  /** The jurisdiction the examples belong to, when the page shows several. */
  title?: string | undefined;
};

/**
 * What an identifier looks like here, as chips that run the same entry the
 * box would. A reader who has never typed a docket number learns the shape
 * by pressing one.
 */
export const IdentifierExamplesCard = ({
  examples,
  onExampleSelect,
  title,
}: IdentifierExamplesCardProps) => {
  const t = useTranslations();

  if (examples.length === 0) {
    return null;
  }

  return (
    <LawHomeCard heading={t("lawHome.tryIdentifier")} title={title}>
      <div className="flex flex-wrap gap-2">
        {examples.map((example) => (
          <Button
            className="h-7 text-xs font-normal"
            key={example}
            onClick={() => onExampleSelect(example)}
            size="sm"
            type="button"
            variant="outline"
          >
            <BidiText as="span">{example}</BidiText>
          </Button>
        ))}
      </div>
    </LawHomeCard>
  );
};

/**
 * The signed-in reader's own tables. Anonymous readers get nothing in this
 * slot: the card is about their work, not about the corpus.
 */
export const ResearchTablesCard = () => {
  const authStatus = useClientAuthStatus();

  if (!authStatus.isAuthenticated) {
    return null;
  }

  return (
    <ResearchTablesCardBody
      activeOrganizationId={authStatus.user.activeOrganizationId}
    />
  );
};

const ResearchTablesCardBody = ({
  activeOrganizationId,
}: {
  activeOrganizationId: string;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const { data } = useInfiniteQuery(
    researchTablesInfiniteOptions({ activeOrganizationId }),
  );
  const firstPage = data?.pages.at(0);
  const tables =
    firstPage === undefined
      ? []
      : firstPage.items.slice(0, RESEARCH_TABLES_PER_CARD);

  if (tables.length === 0) {
    return null;
  }

  return (
    <LawHomeCard
      heading={t("caseLaw.research.title")}
      showAll={
        <Link className={LAW_HOME_SHOW_ALL_CLASS} to="/law/cases/research">
          {t("common.showAll")}
        </Link>
      }
    >
      <LawHomeRowList>
        {tables.map((table) => {
          const updatedAt = parseDeterministicDate(table.updatedAt);
          return (
            <LawHomeRow
              key={table.id}
              line={
                updatedAt === null
                  ? null
                  : t("caseLaw.research.updated", {
                      date: format.dateTime(updatedAt, {
                        dateStyle: "medium",
                      }),
                    })
              }
              title={
                <Link
                  className="text-foreground font-medium hover:underline"
                  params={{ tableId: table.id }}
                  to="/law/cases/research/$tableId"
                >
                  <BidiText>{table.name}</BidiText>
                </Link>
              }
            />
          );
        })}
      </LawHomeRowList>
    </LawHomeCard>
  );
};

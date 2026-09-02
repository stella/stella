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
import type { LegislationShelf } from "@/features/statutes/queries/statutes";
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
  LawHomeCardGroup,
  LawHomeRow,
  LawHomeRowList,
} from "@/routes/law/-law-home/law-home-card";

/** Rows per group: a sample the reader scans, not a list they work through. */
const ROWS_PER_GROUP = 3;
const RESEARCH_TABLES_PER_CARD = 5;

/** The seeded rank labels the shelf reports, as the words a reader knows. */
const TIER_LABEL_KEYS = {
  constitutional: "lawHome.tier.constitutional",
  supreme: "lawHome.tier.supreme",
} as const satisfies Record<"constitutional" | "supreme", TranslationKey>;

const isKnownTier = (value: string): value is keyof typeof TIER_LABEL_KEYS =>
  Object.hasOwn(TIER_LABEL_KEYS, value);

type TopCourtsCardProps = {
  /** The pill's value, so "show all" keeps the reader's scope. */
  countryParam: string;
  groups: readonly LatestDecisionsCourt[];
};

/** The newest decisions of the jurisdiction's apex courts, one group per court. */
export const TopCourtsCard = ({ countryParam, groups }: TopCourtsCardProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const shown = groups.filter((group) => group.decisions.length > 0);

  if (shown.length === 0) {
    return null;
  }

  return (
    <LawHomeCard
      heading={t("lawHome.topCourts")}
      showAll={
        <Link
          className={LAW_HOME_SHOW_ALL_CLASS}
          search={{ country: countryParam }}
          to="/law/cases"
        >
          {t("common.showAll")}
        </Link>
      }
    >
      {shown.map((group) => (
        <LawHomeCardGroup
          key={group.court}
          tag={
            isKnownTier(group.tierLabel)
              ? t(TIER_LABEL_KEYS[group.tierLabel])
              : null
          }
          title={
            <Link
              className="hover:underline"
              search={{ country: countryParam, court: group.court }}
              to="/law/cases"
            >
              {group.court}
            </Link>
          }
        >
          <LawHomeRowList>
            {group.decisions.slice(0, ROWS_PER_GROUP).map((decision) => (
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
        </LawHomeCardGroup>
      ))}
    </LawHomeCard>
  );
};

/** The two sides of the legislation shelf, in the order a reader expects them. */
const SHELF_SIDES = ["recentlyInForce", "enteringIntoForce"] as const;

type LegislationShelfSide = (typeof SHELF_SIDES)[number];

const SHELF_HEADING_KEYS = {
  enteringIntoForce: "lawHome.enteringIntoForce",
  recentlyInForce: "lawHome.recentlyInForce",
} as const satisfies Record<LegislationShelfSide, TranslationKey>;

type LegislationCardProps = {
  country: StatuteCountry;
  shelf: LegislationShelf;
};

/** What recently came into force and what is about to, one group each. */
export const LegislationCard = ({ country, shelf }: LegislationCardProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const sides = SHELF_SIDES.map((side) => ({
    side,
    items: shelf[side].slice(0, ROWS_PER_GROUP),
  })).filter(({ items }) => items.length > 0);

  if (sides.length === 0) {
    return null;
  }

  const validityLine = (side: LegislationShelfSide, date: string): string =>
    side === "recentlyInForce"
      ? t("statutes.inForceSince", { date })
      : t("lawHome.inForceFrom", { date });

  return (
    <LawHomeCard
      heading={t("statutes.title")}
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
      {sides.map(({ side, items }) => (
        <LawHomeCardGroup key={side} title={t(SHELF_HEADING_KEYS[side])}>
          <LawHomeRowList>
            {items.map((item) => {
              const date = formatValidityDate(item.versionValidFrom, format);
              return (
                <LawHomeRow
                  key={item.id}
                  line={date === null ? null : validityLine(side, date)}
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
        </LawHomeCardGroup>
      ))}
    </LawHomeCard>
  );
};

type IdentifierExamplesProps = {
  examples: readonly string[];
  /** What the chips are introduced as; the jurisdiction when the page shows several. */
  label?: string | undefined;
  onExampleSelect: (example: string) => void;
};

/**
 * What an identifier looks like here, as chips under the box that run the
 * same entry the box would. A reader who has never typed a docket number
 * learns the shape by pressing one.
 */
export const IdentifierExamples = ({
  examples,
  label,
  onExampleSelect,
}: IdentifierExamplesProps) => {
  const t = useTranslations();

  if (examples.length === 0) {
    return null;
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="text-muted-foreground text-xs">
        {label ?? t("lawHome.tryIdentifier")}
      </span>
      {examples.map((example) => (
        <Button
          className="text-muted-foreground hover:text-foreground h-6 px-1.5 text-xs font-normal"
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

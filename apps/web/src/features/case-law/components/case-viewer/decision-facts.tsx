import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { DetailsGrid, DetailsItem } from "@stll/ui/details-grid";
import { ExternalLinkIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import {
  buildDecisionFacts,
  DECISION_FACT_KINDS,
  decisionFactIsPresent,
} from "@/features/case-law/components/case-viewer/decision-facts.logic";
import type {
  DecisionFactKind,
  DecisionFacts as DecisionFactValues,
  DecisionFactsInput,
} from "@/features/case-law/components/case-viewer/decision-facts.logic";
import { DecisionJudges } from "@/features/case-law/components/case-viewer/decision-judges";
import type { TranslationKey } from "@/i18n/types";
import { sanitizeHref } from "@/lib/sanitize-href";

/**
 * How each fact is labelled and printed. One entry per fact kind, so a fact
 * a surface can select is a fact the reader can draw.
 */
const FACT_ROWS = {
  decisionType: {
    label: "common.type",
    render: (facts) => <span className="capitalize">{facts.decisionType}</span>,
  },
  judges: {
    label: "caseLaw.viewer.judges",
    render: (facts) => <DecisionJudges judges={facts.judges} />,
  },
  keywords: {
    label: "inspector.metadata.documentProperties.keys.keywords",
    render: (facts) => facts.keywords.join(", "),
  },
  legalAreas: {
    label: "caseLaw.viewer.legalArea",
    render: (facts) => facts.legalAreas.join(" · "),
  },
  source: {
    label: "common.source",
    render: (facts) => <SourceLink source={facts.source} />,
  },
  subject: {
    label: "inspector.metadata.documentProperties.keys.subject",
    render: (facts) => facts.subject,
  },
} as const satisfies Record<
  DecisionFactKind,
  { label: TranslationKey; render: (facts: DecisionFactValues) => ReactNode }
>;

type DecisionFactsProps = DecisionFactsInput & {
  className?: string | undefined;
  /** Core identifiers share the publisher facts' label tracks. */
  children?: ReactNode;
  /** Which facts this surface prints; the rest are shown elsewhere. */
  facts: readonly DecisionFactKind[];
};

/**
 * Publisher facts above the text: what kind of decision, which area of law,
 * who reported it, and where it came from. Quiet by design; the text is the
 * content, this is its label.
 *
 * The caller names the facts it prints, because a surface that already shows
 * one of them in its own chrome must not repeat it in the list.
 */
export const DecisionFacts = ({
  className,
  children,
  facts,
  ...input
}: DecisionFactsProps) => {
  const t = useTranslations();
  const values = buildDecisionFacts(input);
  const shown = DECISION_FACT_KINDS.filter(
    (kind) => facts.includes(kind) && decisionFactIsPresent(values, kind),
  );
  if (shown.length === 0 && children === undefined) {
    return null;
  }

  return (
    <DetailsGrid className={cn("mb-6 print:mb-4", className)}>
      {children}
      {shown.map((kind) => (
        <DetailsItem key={kind} label={t(FACT_ROWS[kind].label)}>
          {FACT_ROWS[kind].render(values)}
        </DetailsItem>
      ))}
    </DetailsGrid>
  );
};

const SourceLink = ({ source }: { source: DecisionFactValues["source"] }) => {
  if (source === null) {
    return null;
  }

  return (
    <a
      className="hover:text-foreground inline-flex items-center gap-1 underline-offset-2 hover:underline"
      href={sanitizeHref(source.url)}
      rel="noopener noreferrer"
      target="_blank"
    >
      {source.name}
      <ExternalLinkIcon aria-hidden="true" className="size-3" />
    </a>
  );
};

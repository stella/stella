import type { ReactNode } from "react";

import { ExternalLinkIcon } from "lucide-react";
import { useTranslations } from "use-intl";

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
  facts,
  ...input
}: DecisionFactsProps) => {
  const t = useTranslations();
  const values = buildDecisionFacts(input);
  const shown = DECISION_FACT_KINDS.filter(
    (kind) => facts.includes(kind) && decisionFactIsPresent(values, kind),
  );
  if (shown.length === 0) {
    return null;
  }

  return (
    <dl
      className={cn(
        "reader-chrome text-muted-foreground mb-6 grid grid-cols-[9rem_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs print:mb-4",
        className,
      )}
    >
      {shown.map((kind) => (
        <Fact key={kind} label={t(FACT_ROWS[kind].label)}>
          {FACT_ROWS[kind].render(values)}
        </Fact>
      ))}
    </dl>
  );
};

const SourceLink = ({ source }: { source: DecisionFactValues["source"] }) => {
  const t = useTranslations();
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
      {source.name ?? t("inspector.external.openOriginal")}
      <ExternalLinkIcon aria-hidden="true" className="size-3" />
    </a>
  );
};

const Fact = ({ children, label }: { children: ReactNode; label: string }) => (
  <>
    <dt className="text-foreground-disabled font-medium tracking-wide uppercase">
      {label}
    </dt>
    <dd className="text-foreground-strong-muted min-w-0">{children}</dd>
  </>
);

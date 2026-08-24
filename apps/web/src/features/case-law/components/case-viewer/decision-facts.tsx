import type { ReactNode } from "react";

import { ExternalLinkIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";

import {
  buildDecisionFacts,
  hasDecisionFacts,
} from "@/features/case-law/components/case-viewer/decision-facts.logic";
import type { DecisionFactsInput } from "@/features/case-law/components/case-viewer/decision-facts.logic";
import { sanitizeHref } from "@/lib/sanitize-href";

/**
 * Publisher facts above the text: what kind of decision, which area of law,
 * who reported it, and where it came from. Quiet by design; the text is the
 * content, this is its label.
 */
export const DecisionFacts = (input: DecisionFactsInput) => {
  const t = useTranslations();
  const facts = buildDecisionFacts(input);
  if (!hasDecisionFacts(facts)) {
    return null;
  }

  return (
    <dl className="text-muted-foreground mb-6 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 font-sans text-xs print:mb-4">
      {facts.decisionType !== null && (
        <Fact label={t("common.type")}>
          <span className="capitalize">{facts.decisionType}</span>
        </Fact>
      )}
      {facts.legalAreas.length > 0 && (
        <Fact label={t("caseLaw.viewer.legalArea")}>
          {facts.legalAreas.join(" · ")}
        </Fact>
      )}
      {facts.subject !== null && (
        <Fact label={t("inspector.metadata.documentProperties.keys.subject")}>
          {facts.subject}
        </Fact>
      )}
      {facts.keywords.length > 0 && (
        <Fact label={t("inspector.metadata.documentProperties.keys.keywords")}>
          {facts.keywords.join(", ")}
        </Fact>
      )}
      {facts.judge !== null && (
        <Fact label={t("caseLaw.viewer.judgeRapporteur")}>
          <BidiText as="span">{facts.judge}</BidiText>
        </Fact>
      )}
      {facts.source !== null && (
        <Fact label={t("common.source")}>
          <a
            className="hover:text-foreground inline-flex items-center gap-1 underline-offset-2 hover:underline"
            href={sanitizeHref(facts.source.url)}
            rel="noopener noreferrer"
            target="_blank"
          >
            {facts.source.name ?? t("inspector.external.openOriginal")}
            <ExternalLinkIcon aria-hidden="true" className="size-3" />
          </a>
        </Fact>
      )}
    </dl>
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

import { useTranslations } from "use-intl";

type Section = {
  index: number;
  type: string;
  title: string | null;
  text: string;
};

type Decision = {
  caseNumber: string;
  court: string;
  fulltext: string | null;
};

type DecisionTextProps = {
  decision: Decision;
  sections: Section[];
};

export const DecisionText = ({ decision, sections }: DecisionTextProps) => {
  const t = useTranslations();

  // If we have structured sections, render them
  if (sections.length > 0) {
    return (
      <article className="mx-auto max-w-3xl space-y-6">
        <header>
          <h1 className="text-xl font-semibold">{decision.caseNumber}</h1>
          <p className="text-sm text-muted-foreground">{decision.court}</p>
        </header>

        {sections.map((section) => (
          <section id={`section-${section.index}`} key={section.index}>
            {section.title && (
              <h2 className="mb-2 text-base font-semibold">{section.title}</h2>
            )}
            <div className="text-sm leading-relaxed whitespace-pre-wrap">
              {section.text}
            </div>
          </section>
        ))}
      </article>
    );
  }

  // Fallback: render raw fulltext
  if (decision.fulltext) {
    return (
      <article className="mx-auto max-w-3xl space-y-6">
        <header>
          <h1 className="text-xl font-semibold">{decision.caseNumber}</h1>
          <p className="text-sm text-muted-foreground">{decision.court}</p>
        </header>
        <div className="text-sm leading-relaxed whitespace-pre-wrap">
          {decision.fulltext}
        </div>
      </article>
    );
  }

  return (
    <div className="flex items-center justify-center py-16">
      <p className="text-sm text-muted-foreground">{t("caseLaw.emptyState")}</p>
    </div>
  );
};

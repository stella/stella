import { useTranslations } from "use-intl";

type MetadataPanelProps = {
  decision: {
    caseNumber: string;
    ecli: string | null;
    court: string;
    country: string;
    language: string;
    decisionDate: string | null;
    decisionType: string | null;
    sourceUrl: string | null;
    metadata: Record<string, unknown> | null;
    source: {
      id: string;
      name: string;
      adapterKey: string;
    };
    citationsFrom: {
      id: string;
      citationText: string;
      citedDecisionId: string | null;
    }[];
    citationsTo: {
      id: string;
      citationText: string;
      citingDecisionId: string | null;
    }[];
  };
};

const MetadataField = ({
  label,
  value,
}: {
  label: string;
  value: Date | string | null | undefined;
}) => {
  if (value === undefined || value === null) {
    return null;
  }

  const display = value instanceof Date ? value.toLocaleDateString() : value;

  return (
    <div>
      <dt className="text-muted-foreground text-xs font-medium">{label}</dt>
      <dd className="text-sm">{display}</dd>
    </div>
  );
};

export const MetadataPanel = ({ decision }: MetadataPanelProps) => {
  const t = useTranslations();
  const legalSentence = decision.metadata?.legalSentence;

  return (
    <div className="space-y-4">
      <h3 className="text-muted-foreground text-xs font-semibold uppercase">
        {t("caseLaw.viewer.metadata")}
      </h3>

      <dl className="space-y-3">
        <MetadataField
          label={t("caseLaw.columns.court")}
          value={decision.court}
        />
        <MetadataField
          label={t("caseLaw.columns.decisionDate")}
          value={decision.decisionDate}
        />
        <MetadataField label="ECLI" value={decision.ecli} />
        <MetadataField
          label={t("caseLaw.columns.country")}
          value={decision.country}
        />
        <MetadataField
          label={t("caseLaw.viewer.language")}
          value={decision.language}
        />
        <MetadataField
          label={t("caseLaw.columns.decisionType")}
          value={decision.decisionType}
        />
        <MetadataField
          label={t("caseLaw.viewer.source")}
          value={decision.source.name}
        />
      </dl>

      {typeof legalSentence === "string" && legalSentence.length > 0 && (
        <div>
          <h4 className="text-muted-foreground mb-1 text-xs font-semibold">
            {t("caseLaw.viewer.legalSentence")}
          </h4>
          <p className="bg-muted/50 rounded-md p-3 text-sm leading-relaxed">
            {legalSentence}
          </p>
        </div>
      )}

      {decision.sourceUrl && (
        <div>
          <a
            className="text-sm text-blue-600 hover:underline dark:text-blue-400"
            href={decision.sourceUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            {t("caseLaw.viewer.viewOriginal")}
          </a>
        </div>
      )}

      {decision.citationsFrom.length > 0 && (
        <div>
          <h4 className="text-muted-foreground mb-1 text-xs font-semibold">
            {`${t("caseLaw.viewer.cites")} (${decision.citationsFrom.length})`}
          </h4>
          <ul className="space-y-1">
            {decision.citationsFrom.slice(0, 10).map((citation) => (
              <li className="text-muted-foreground text-xs" key={citation.id}>
                {citation.citationText}
              </li>
            ))}
          </ul>
        </div>
      )}

      {decision.citationsTo.length > 0 && (
        <div>
          <h4 className="text-muted-foreground mb-1 text-xs font-semibold">
            {`${t("caseLaw.viewer.citedBy")} (${decision.citationsTo.length})`}
          </h4>
          <ul className="space-y-1">
            {decision.citationsTo.slice(0, 10).map((citation) => (
              <li className="text-muted-foreground text-xs" key={citation.id}>
                {citation.citationText}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

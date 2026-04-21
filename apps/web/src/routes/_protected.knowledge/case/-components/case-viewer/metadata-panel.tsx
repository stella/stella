import { useState } from "react";

import { useTranslations } from "use-intl";

import { getDocumentAstMetadata } from "@stella/case-law/document-ast";
import { Button } from "@stella/ui/components/button";

/**
 * Countries with a single official court language.
 * Language field is redundant for these; hide it in the UI.
 */
const MONOLINGUAL_COUNTRIES = new Set(["CZE", "SVK", "POL", "AUT"]);

/**
 * Convert API URLs to public-facing court page URLs.
 * e.g. finaldoc API → rozhodnuti.justice.cz/rozhodnuti/
 */
const humanizeSourceUrl = (url: string): string => {
  // Regional courts: API endpoint → public page
  const finaldocMatch = /rozhodnuti\.justice\.cz\/api\/finaldoc\/(.+)/.exec(
    url,
  );
  if (finaldocMatch) {
    return `https://rozhodnuti.justice.cz/rozhodnuti/${finaldocMatch[1]}`;
  }
  return url;
};

/** Extract a human-readable label from a source URL. */
const sourceLabel = (url: string): string => {
  if (!URL.canParse(url)) {
    return url;
  }

  return new URL(url).hostname.replace(/^www\./, "");
};

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
    documentAst?: unknown;
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

const TagList = ({
  label,
  values,
}: {
  label: string;
  values: readonly string[];
}) => {
  if (values.length === 0) {
    return null;
  }

  return (
    <div>
      <dt className="text-muted-foreground mb-1 text-xs font-medium">
        {label}
      </dt>
      <dd className="flex flex-wrap gap-1">
        {values.map((v) => (
          <span className="bg-muted rounded px-1.5 py-0.5 text-xs" key={v}>
            {v}
          </span>
        ))}
      </dd>
    </div>
  );
};

/** Source-specific fields (excludes duplicates of AST metadata). */
const SOURCE_FIELD_LABELS: Record<string, string> = {
  kategorieRozhodnuti: "Kategorie rozhodnutí",
  zverejnenoNaWebu: "Zveřejněno na webu",
  legalSentence: "Právní věta",
};

/** Extract the popular name from source metadata (ÚS decisions). */
const getPopularName = (meta: Record<string, unknown>): string | null => {
  const val = meta.popularName;
  return typeof val === "string" && val.length > 0 ? val : null;
};

export const MetadataPanel = ({ decision }: MetadataPanelProps) => {
  const t = useTranslations();
  const [expanded, setExpanded] = useState(false);

  const astMeta = getDocumentAstMetadata(decision.documentAst);
  const sourceMeta = decision.metadata ?? {};
  const popularName = getPopularName(sourceMeta);

  const sourceFields: { label: string; value: string }[] = [];
  for (const [key, val] of Object.entries(sourceMeta)) {
    const label = SOURCE_FIELD_LABELS[key];
    if (!label || val === null || val === undefined) {
      continue;
    }
    if (Array.isArray(val)) {
      sourceFields.push({ label, value: val.join(", ") });
    } else if (typeof val === "string" || typeof val === "number") {
      sourceFields.push({ label, value: String(val) });
    }
  }

  const hasExtra =
    sourceFields.length > 0 ||
    (astMeta?.keywords?.length ?? 0) > 0 ||
    (astMeta?.statutes?.length ?? 0) > 0;

  return (
    <div className="space-y-4">
      <h3 className="text-muted-foreground text-xs font-semibold uppercase">
        {t("common.metadata")}
      </h3>

      <dl className="space-y-3">
        <MetadataField
          label={t("caseLaw.columns.court")}
          value={decision.court}
        />
        {popularName && (
          <MetadataField
            label={t("caseLaw.viewer.popularName")}
            value={popularName}
          />
        )}
        <MetadataField label={t("common.date")} value={decision.decisionDate} />
        <MetadataField label="ECLI" value={decision.ecli} />
        <MetadataField
          label={t("caseLaw.columns.country")}
          value={decision.country}
        />
        {!MONOLINGUAL_COUNTRIES.has(decision.country) && (
          <MetadataField
            label={t("common.language")}
            value={decision.language}
          />
        )}
        <MetadataField label={t("common.type")} value={decision.decisionType} />
        <MetadataField
          label={t("caseLaw.viewer.source")}
          value={decision.source.name}
        />
      </dl>

      {hasExtra && !expanded && (
        <Button
          className="w-full"
          onClick={() => setExpanded(true)}
          size="sm"
          variant="ghost"
        >
          {t("common.showMore")}
        </Button>
      )}

      {expanded && (
        <dl className="space-y-3 border-t pt-3">
          {astMeta?.keywords && (
            <TagList
              label={t("caseLaw.viewer.keywords")}
              values={astMeta.keywords}
            />
          )}
          {astMeta?.statutes && (
            <TagList
              label={t("caseLaw.viewer.statutes")}
              values={astMeta.statutes}
            />
          )}
          {sourceFields.map((f) => (
            <MetadataField key={f.label} label={f.label} value={f.value} />
          ))}
        </dl>
      )}

      {decision.sourceUrl && (
        <div>
          <a
            className="text-sm text-blue-600 hover:underline dark:text-blue-400"
            href={humanizeSourceUrl(decision.sourceUrl)}
            rel="noopener noreferrer"
            target="_blank"
          >
            {t("caseLaw.viewer.viewOriginal")} —{" "}
            {sourceLabel(decision.sourceUrl)}
          </a>
        </div>
      )}

      {decision.court === "Ústavní soud" && (
        <p className="text-muted-foreground/70 mt-3 text-[0.7rem] leading-snug italic">
          {t("caseLaw.viewer.nalusDisclaimer")}
        </p>
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

import { useState } from "react";

import { useTranslations } from "use-intl";

import { getDocumentAstMetadata } from "@stll/case-law/document-ast";
import { Button } from "@stll/ui/components/button";

import type { TranslationKey } from "@/i18n/types";
import { sanitizeHref } from "@/lib/sanitize-href";

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
  const finaldocMatch = /rozhodnuti\.justice\.cz\/api\/finaldoc\/(.+)/u.exec(
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

  return new URL(url).hostname.replace(/^www\./u, "");
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
const SOURCE_FIELD_KEYS = {
  decisionCategory: "kategorieRozhodnuti",
  legalSentence: "legalSentence",
  publishedOnWeb: "zverejnenoNaWebu",
} as const;

type SourceFieldKey =
  (typeof SOURCE_FIELD_KEYS)[keyof typeof SOURCE_FIELD_KEYS];

const SOURCE_FIELD_LABEL_KEYS = {
  [SOURCE_FIELD_KEYS.decisionCategory]:
    "caseLaw.viewer.sourceFields.decisionCategory",
  [SOURCE_FIELD_KEYS.legalSentence]: "caseLaw.viewer.legalSentence",
  [SOURCE_FIELD_KEYS.publishedOnWeb]:
    "caseLaw.viewer.sourceFields.publishedOnWeb",
} as const satisfies Record<SourceFieldKey, TranslationKey>;

const isSourceFieldKey = (key: string): key is SourceFieldKey =>
  key in SOURCE_FIELD_LABEL_KEYS;

/** Extract the popular name from source metadata (ÚS decisions). */
const getPopularName = (meta: Record<string, unknown>): string | null => {
  const val = meta["popularName"];
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
    if (!isSourceFieldKey(key) || val === null || val === undefined) {
      continue;
    }
    const label = t(SOURCE_FIELD_LABEL_KEYS[key]);

    if (Array.isArray(val)) {
      sourceFields.push({ label, value: val.join(", ") });
    } else if (typeof val === "string" || typeof val === "number") {
      sourceFields.push({ label, value: String(val) });
    }
  }

  const astKeywords = astMeta?.keywords ?? [];
  const astStatutes = astMeta?.statutes ?? [];
  const hasExtra =
    sourceFields.length > 0 || astKeywords.length > 0 || astStatutes.length > 0;

  const sourceHref = decision.sourceUrl
    ? sanitizeHref(humanizeSourceUrl(decision.sourceUrl))
    : undefined;

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
        <MetadataField label={t("common.country")} value={decision.country} />
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
          {astKeywords.length > 0 && (
            <TagList
              label={t("caseLaw.viewer.keywords")}
              values={astKeywords}
            />
          )}
          {astStatutes.length > 0 && (
            <TagList
              label={t("caseLaw.viewer.statutes")}
              values={astStatutes}
            />
          )}
          {sourceFields.map((f) => (
            <MetadataField key={f.label} label={f.label} value={f.value} />
          ))}
        </dl>
      )}

      {sourceHref && decision.sourceUrl && (
        <div>
          <a
            className="text-foreground dark:text-foreground-muted text-sm hover:underline"
            href={sourceHref}
            rel="noopener noreferrer"
            target="_blank"
          >
            {t("caseLaw.viewer.viewOriginal")} —{" "}
            {sourceLabel(decision.sourceUrl)}
          </a>
        </div>
      )}

      {decision.court === "Ústavní soud" && (
        <p className="text-foreground-ghost mt-3 text-[0.7rem] leading-snug italic">
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

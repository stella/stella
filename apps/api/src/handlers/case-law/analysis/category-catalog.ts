import type { AnalysisHeading } from "@stll/case-law/analysis";

const CORE_CATEGORIES = [
  "facts",
  "procedural-history",
  "reasoning",
  "holding",
] as const;

type CoreCategory = (typeof CORE_CATEGORIES)[number];

const CATEGORY_LANGUAGES = ["cs", "de", "en", "pl", "sk"] as const;

type CategoryLanguage = (typeof CATEGORY_LANGUAGES)[number];

const CORE_CATEGORY_LABELS = {
  cs: {
    facts: "Skutkový stav",
    "procedural-history": "Procesní historie",
    reasoning: "Právní posouzení",
    holding: "Výrok",
  },
  de: {
    facts: "Sachverhalt",
    "procedural-history": "Verfahrensgang",
    reasoning: "Rechtliche Beurteilung",
    holding: "Spruch",
  },
  en: {
    facts: "Facts",
    "procedural-history": "Procedural history",
    reasoning: "Reasoning",
    holding: "Holding",
  },
  pl: {
    facts: "Stan faktyczny",
    "procedural-history": "Przebieg postępowania",
    reasoning: "Ocena prawna",
    holding: "Sentencja",
  },
  sk: {
    facts: "Skutkový stav",
    "procedural-history": "Procesná história",
    reasoning: "Právne posúdenie",
    holding: "Výrok",
  },
} as const satisfies Record<CategoryLanguage, Record<CoreCategory, string>>;

const resolveLanguage = (language: string): CategoryLanguage =>
  CATEGORY_LANGUAGES.find((value) => value === language) ?? "en";

const normalizeLabel = (label: string): string =>
  label.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

const isCoreCategory = (category: string): category is CoreCategory =>
  CORE_CATEGORIES.some((value) => value === category);

export const buildCategoryCatalogPrompt = (language: string): string => {
  const labels = CORE_CATEGORY_LABELS[resolveLanguage(language)];
  const rows = CORE_CATEGORIES.map(
    (category) => `| ${category} | ${labels[category]} |`,
  ).join("\n");

  return `## Category catalog

Use \`category\` as a stable machine key and \`label\` as the user-visible title in the decision language.

| category | label |
| --- | --- |
${rows}

For narrower legal topics, use the closest core category when possible. Use a concise language-specific category only when no core category fits. The label must still be in the decision language.`;
};

export const normalizeAnalysisHeadingLabels = ({
  heading,
  language,
}: {
  heading: AnalysisHeading;
  language: string;
}): AnalysisHeading => {
  const children = heading.children.map((child) =>
    normalizeAnalysisHeadingLabels({ heading: child, language }),
  );

  if (!isCoreCategory(heading.category)) {
    return { ...heading, children };
  }

  const normalized = normalizeLabel(heading.label);
  const englishLabel = normalizeLabel(
    CORE_CATEGORY_LABELS.en[heading.category],
  );
  const categoryLabel = normalizeLabel(heading.category);

  if (normalized !== englishLabel && normalized !== categoryLabel) {
    return { ...heading, children };
  }

  return {
    ...heading,
    children,
    label: CORE_CATEGORY_LABELS[resolveLanguage(language)][heading.category],
  };
};

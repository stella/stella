import type { CaseLawFixture, FixtureDecision } from "./seed-case-law";

const LANGUAGES = [
  "bg",
  "cs",
  "da",
  "de",
  "el",
  "en",
  "es",
  "et",
  "fi",
  "fr",
  "hr",
  "hu",
  "it",
  "lt",
  "lv",
  "mt",
  "nl",
  "pl",
  "pt",
  "ro",
  "sk",
  "sl",
  "sv",
] as const;

const DOCUMENTS = [
  {
    ecli: "ECLI:EU:C:2019:246",
    date: "2019-03-21",
    type: "opinion",
    label: "Advocate General opinion",
  },
  {
    ecli: "ECLI:EU:C:2019:801",
    date: "2019-10-01",
    type: "judgment",
    label: "Judgment",
  },
] as const;

/** Public identifiers with synthetic text; this fixture is no legal authority. */
export const planet49CaseLawFixture = () =>
  ({
    source: {
      adapter_key: "eu-ecj",
      name: "Court of Justice of the European Union",
      enabled: false,
      config: null,
    },
    decisions: DOCUMENTS.flatMap((document) =>
      LANGUAGES.map((language) => {
        const fulltext = [
          `Planet49 · C-673/17 · ${document.label}`,
          `Synthetic presentation fixture (${language}). This is demonstration text, not the court's decision or a translation of it.`,
          `${document.ecli} · ${document.date}`,
          "This neutral fixture exercises document navigation, language selection and search results. No legal holding is reproduced or asserted.",
        ].join("\n\n");
        return {
          case_number: "C-673/17",
          slug: null,
          ecli: document.ecli,
          court: "Court of Justice",
          country: "EU",
          language,
          language_group_key: document.ecli,
          decision_date: document.date,
          decision_type: document.type,
          fulltext,
          sections: null,
          document_ast: {
            version: 1,
            source: {
              system: "stella-synthetic-seed",
              documentId: `${document.ecli}:${language}`,
              webUrl: "",
              printUrl: "",
            },
            metadata: {
              caseNumber: "C-673/17",
              ecli: document.ecli,
              court: "Court of Justice",
              decisionDate: document.date,
              decisionType: document.type,
              keywords: [],
              statutes: [],
            },
            blocks: fulltext.split("\n\n").map((plainText, index) => ({
              id: `p${index + 1}`,
              anchorId: `p${index + 1}`,
              type: "paragraph",
              number: index + 1,
              inlines: [{ type: "text", text: plainText }],
              plainText,
            })),
          },
          analysis: null,
          parser_version: 0,
          source_raw: null,
          source_raw_s3_key: null,
          source_raw_content_type: null,
          source_url: null,
          document_url: null,
          metadata: { synthetic: true, caseName: "Planet49" },
          source_hash: null,
        } satisfies FixtureDecision;
      }),
    ),
  }) satisfies CaseLawFixture;

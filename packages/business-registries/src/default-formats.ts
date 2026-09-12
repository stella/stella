import { ARES_DEFAULT_FORMAT } from "./ares/default-format.js";

export type RegistryFormatCapability =
  | {
      type: "company-specification";
      defaultFormat: string;
      resultShape: "full-record";
    }
  | {
      type: "registry-reference";
      defaultFormat: string;
      resultShape: "search-result" | "full-record";
    };

export const REGISTRY_FORMAT_SLUGS: readonly [
  "ares",
  "brreg",
  "companies-house",
  "denue",
  "edgar",
  "gcis",
  "krs",
  "orsr",
  "prh",
  "recherche-entreprises",
  "vies",
] = [
  "ares",
  "brreg",
  "companies-house",
  "denue",
  "edgar",
  "gcis",
  "krs",
  "orsr",
  "prh",
  "recherche-entreprises",
  "vies",
];

export type RegistryFormatSlug = (typeof REGISTRY_FORMAT_SLUGS)[number];

export type RegistryFormatRun = {
  text: string;
  style: "plain" | "bold" | "italic";
  start: number;
};

const REGISTRY_FORMAT_MARKDOWN_RE =
  /\*\*(?<bold>[^*]+)\*\*|(?<!\*)\*(?<italic>[^*]+)\*(?!\*)/gu;

/** Parse the bold and italic markers supported by registry format templates. */
export const parseRegistryFormatMarkdown = (
  text: string,
): RegistryFormatRun[] => {
  const runs: RegistryFormatRun[] = [];
  let cursor = 0;
  for (const match of text.matchAll(REGISTRY_FORMAT_MARKDOWN_RE)) {
    if (match.index > cursor) {
      runs.push({
        text: text.slice(cursor, match.index),
        style: "plain",
        start: cursor,
      });
    }
    const [, bold, italic] = match;
    if (bold !== undefined) {
      runs.push({ text: bold, style: "bold", start: match.index });
    } else if (italic !== undefined) {
      runs.push({ text: italic, style: "italic", start: match.index });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    runs.push({ text: text.slice(cursor), style: "plain", start: cursor });
  }
  return runs;
};

/** Remove supported format markers for plain-text clipboard output. */
export const stripRegistryFormatMarkdown = (text: string): string =>
  parseRegistryFormatMarkdown(text)
    .map(({ text: runText }) => runText)
    .join("");

/**
 * Built-in output semantics for each registry. A company specification is
 * offered only when the upstream record contains the jurisdiction's core
 * party-identification particulars. Directory, filer, VAT, and incomplete
 * registry records are labelled as references instead.
 */
export const BUSINESS_REGISTRY_FORMAT_CAPABILITIES: Readonly<
  Record<RegistryFormatSlug, RegistryFormatCapability>
> = {
  ares: {
    type: "company-specification",
    defaultFormat: ARES_DEFAULT_FORMAT,
    resultShape: "full-record",
  },
  brreg: {
    type: "company-specification",
    defaultFormat:
      "**[company name]**, [legal form], organisasjonsnummer [registry number], forretningsadresse [address]",
    resultShape: "full-record",
  },
  "companies-house": {
    type: "company-specification",
    defaultFormat:
      "**[company name]**, a [legal form] registered in [jurisdiction] under company number [registry number], whose registered office is at [address]",
    resultShape: "full-record",
  },
  denue: {
    type: "registry-reference",
    defaultFormat:
      "**[company name]**, DENUE establishment [registry number], [address]",
    resultShape: "search-result",
  },
  edgar: {
    type: "registry-reference",
    defaultFormat:
      "**[company name]**, SEC CIK [registry number], EIN [EIN], [address]",
    resultShape: "full-record",
  },
  gcis: {
    type: "company-specification",
    defaultFormat:
      "**[company name]**，統一編號 [registry number]，公司所在地 [address]，登記機關 [registering authority]",
    resultShape: "full-record",
  },
  krs: {
    type: "registry-reference",
    defaultFormat:
      "**[company name]**, siedziba: [seat], adres: [address], KRS: [registry number], NIP: [NIP], REGON: [REGON], kapitał zakładowy: [share capital]",
    resultShape: "full-record",
  },
  orsr: {
    type: "company-specification",
    defaultFormat:
      "**[company name]**, sídlo: [address], IČO: [registry number], zápis v obchodnom registri: [court file]",
    resultShape: "full-record",
  },
  prh: {
    type: "registry-reference",
    defaultFormat:
      "**[company name]**, Y-tunnus [registry number], osoite [address]",
    resultShape: "search-result",
  },
  "recherche-entreprises": {
    type: "registry-reference",
    defaultFormat:
      "**[company name]**, SIREN [SIREN], siège social : [head office address], SIRET [SIRET]",
    resultShape: "full-record",
  },
  vies: {
    type: "registry-reference",
    defaultFormat: "**[company name]**, VAT number [VAT number], [address]",
    resultShape: "full-record",
  },
};

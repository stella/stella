import { ARES_DEFAULT_FORMAT } from "./ares/default-format.js";
import {
  BRREG_DEFAULT_FORMAT,
  BRREG_DEFAULT_FORMAT_CLAUSES,
} from "./brreg/default-format.js";
import {
  COMPANIES_HOUSE_DEFAULT_FORMAT,
  COMPANIES_HOUSE_DEFAULT_FORMAT_CLAUSES,
} from "./companies-house/default-format.js";
import type { RegistryFormatClause } from "./format-clauses.js";
import {
  KRS_DEFAULT_FORMAT,
  KRS_DEFAULT_FORMAT_CLAUSES,
} from "./krs/default-format.js";
import {
  ORSR_DEFAULT_FORMAT,
  ORSR_DEFAULT_FORMAT_CLAUSES,
} from "./orsr/default-format.js";
import {
  PRH_DEFAULT_FORMAT,
  PRH_DEFAULT_FORMAT_CLAUSES,
} from "./prh/default-format.js";
import {
  RECHERCHE_ENTREPRISES_DEFAULT_FORMAT,
  RECHERCHE_ENTREPRISES_DEFAULT_FORMAT_CLAUSES,
} from "./recherche-entreprises/default-format.js";

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
  "rpo",
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
  "rpo",
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
    defaultFormat: BRREG_DEFAULT_FORMAT,
    resultShape: "full-record",
  },
  "companies-house": {
    type: "company-specification",
    defaultFormat: COMPANIES_HOUSE_DEFAULT_FORMAT,
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
    defaultFormat: KRS_DEFAULT_FORMAT,
    resultShape: "full-record",
  },
  orsr: {
    type: "company-specification",
    defaultFormat: ORSR_DEFAULT_FORMAT,
    resultShape: "full-record",
  },
  prh: {
    type: "registry-reference",
    defaultFormat: PRH_DEFAULT_FORMAT,
    resultShape: "search-result",
  },
  "recherche-entreprises": {
    type: "registry-reference",
    defaultFormat: RECHERCHE_ENTREPRISES_DEFAULT_FORMAT,
    resultShape: "full-record",
  },
  // RPO spans every Slovak legal person and entrepreneur, most of which have
  // no court file, so its output cites the IČO rather than a registration.
  rpo: {
    type: "registry-reference",
    defaultFormat:
      "**[company name]**, [legal form], sídlo: [address], IČO: [registry number]",
    resultShape: "full-record",
  },
  vies: {
    type: "registry-reference",
    defaultFormat: "**[company name]**, VAT number [VAT number], [address]",
    resultShape: "full-record",
  },
};

/**
 * Registries whose built-in output is assembled from a clause list, and those
 * that render some other way: ARES assembles its own parts (its opening clause
 * depends on the legal form), and the registry-reference sources render a
 * fixed reference rather than a party clause.
 *
 * The two lists partition the slugs — asserted below — so adding a registry
 * fails to compile until it picks a side, rather than silently inheriting one.
 */
export const CLAUSE_DRIVEN_REGISTRY_SLUGS = [
  "brreg",
  "companies-house",
  "krs",
  "orsr",
  "prh",
  "recherche-entreprises",
] as const;

const NON_CLAUSE_DRIVEN_REGISTRY_SLUGS = [
  "ares",
  "denue",
  "edgar",
  "gcis",
  "rpo",
  "vies",
] as const;

export type ClauseDrivenRegistrySlug =
  (typeof CLAUSE_DRIVEN_REGISTRY_SLUGS)[number];

true satisfies [
  Exclude<
    RegistryFormatSlug,
    ClauseDrivenRegistrySlug | (typeof NON_CLAUSE_DRIVEN_REGISTRY_SLUGS)[number]
  >,
  Extract<
    ClauseDrivenRegistrySlug,
    (typeof NON_CLAUSE_DRIVEN_REGISTRY_SLUGS)[number]
  >,
] extends [never, never]
  ? true
  : never;

/** The clause list behind each clause-driven registry's built-in default. */
export const REGISTRY_DEFAULT_FORMAT_CLAUSES: Readonly<
  Record<ClauseDrivenRegistrySlug, readonly RegistryFormatClause[]>
> = {
  brreg: BRREG_DEFAULT_FORMAT_CLAUSES,
  "companies-house": COMPANIES_HOUSE_DEFAULT_FORMAT_CLAUSES,
  krs: KRS_DEFAULT_FORMAT_CLAUSES,
  orsr: ORSR_DEFAULT_FORMAT_CLAUSES,
  prh: PRH_DEFAULT_FORMAT_CLAUSES,
  "recherche-entreprises": RECHERCHE_ENTREPRISES_DEFAULT_FORMAT_CLAUSES,
};

export const isClauseDrivenRegistry = (
  registry: RegistryFormatSlug,
): registry is ClauseDrivenRegistrySlug =>
  Object.hasOwn(REGISTRY_DEFAULT_FORMAT_CLAUSES, registry);

/**
 * Built-in strings a registry shipped before its current default. A saved copy
 * of one of these is an untouched built-in row, not authored text, so it keeps
 * behaving as the built-in: it renders through the built-in path and is
 * reseeded when the registry changes. The literals are spelled out rather than
 * derived, because a shipped string has to keep meaning what it meant when it
 * shipped. Only the registries listed here ever changed their default; the key
 * union stays `Extract`ed from the slugs so a renamed slug breaks the build.
 */
export const PREVIOUS_DEFAULT_FORMATS: Readonly<
  Record<
    Extract<
      RegistryFormatSlug,
      | "ares"
      | "brreg"
      | "companies-house"
      | "krs"
      | "orsr"
      | "prh"
      | "recherche-entreprises"
    >,
    readonly [string, ...string[]]
  >
> = {
  ares: [
    "společnost **[company name]**, se sídlem [address], IČO: [registry number], zapsaná v obchodním rejstříku vedeném [court instrumental] pod sp. zn. [file reference]",
  ],
  brreg: [
    "**[company name]**, [legal form], organisasjonsnummer [registry number], forretningsadresse [address]",
  ],
  "companies-house": [
    "**[company name]**, a [legal form] registered in [jurisdiction] under company number [registry number], whose registered office is at [address]",
  ],
  krs: [
    "[company name] with its registered office at [address], entered in the Register of Entrepreneurs under KRS no. [registry number], kept by Krajowy Rejestr Sądowy, share capital of [share capital], Tax Identification Number (NIP) [NIP], Statistical Identification Number (REGON) [REGON]",
    "**[company name]**, siedziba: [seat], adres: [address], KRS: [registry number], NIP: [NIP], REGON: [REGON], kapitał zakładowy: [share capital]",
  ],
  orsr: [
    "**[company name]**, sídlo: [address], IČO: [registry number], zápis v obchodnom registri: [court file]",
  ],
  prh: ["**[company name]**, Y-tunnus [registry number], osoite [address]"],
  "recherche-entreprises": [
    "**[company name]**, SIREN [SIREN], siège social : [head office address], SIRET [SIRET]",
  ],
};

/** True when the text is the registry's current built-in output or one it
 *  shipped earlier: either way the author never edited it. */
export const isBuiltInRegistryFormat = (
  registry: RegistryFormatSlug,
  format: string,
): boolean =>
  format === BUSINESS_REGISTRY_FORMAT_CAPABILITIES[registry].defaultFormat ||
  Object.entries(PREVIOUS_DEFAULT_FORMATS).some(
    ([slug, previous]) => slug === registry && previous.includes(format),
  );

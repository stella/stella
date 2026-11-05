import type { NativeToolSlug } from "@stll/catalogue";

import type { TranslationKey } from "@/i18n/types";

// Narrow to these parameter-less keys so `t(key)` type-checks with a single
// argument: the broad TranslationKey union also contains placeholder keys
// whose translator overload requires a values argument.
type NativeToolNameKey = Extract<
  TranslationKey,
  `catalogue.toolNames.${string}`
>;
type NativeToolDescriptionKey = Extract<
  TranslationKey,
  `catalogue.toolDescriptions.${string}`
>;

type NativeToolCopy = {
  /** `null` for a proper name, which reads the same in every language. */
  name: NativeToolNameKey | null;
  description: NativeToolDescriptionKey;
};

/**
 * What each native tool reads in the reader's language. Manifests sit in a
 * shared, language-agnostic package and stay the English source (the English
 * catalog repeats them, which a test holds equal). The map is total over the
 * manifests, so a new native tool does not compile until it is translated.
 */
export const NATIVE_TOOL_COPY = {
  anonymize: {
    name: "catalogue.toolNames.anonymize",
    description: "catalogue.toolDescriptions.anonymize",
  },
  ares: { name: null, description: "catalogue.toolDescriptions.ares" },
  boe: { name: null, description: "catalogue.toolDescriptions.boe" },
  brreg: { name: null, description: "catalogue.toolDescriptions.brreg" },
  "companies-house": {
    name: null,
    description: "catalogue.toolDescriptions.companiesHouse",
  },
  "create-docx": {
    name: "catalogue.toolNames.createDocx",
    description: "catalogue.toolDescriptions.createDocx",
  },
  denue: { name: null, description: "catalogue.toolDescriptions.denue" },
  edgar: { name: null, description: "catalogue.toolDescriptions.edgar" },
  gcis: {
    name: "catalogue.toolNames.gcis",
    description: "catalogue.toolDescriptions.gcis",
  },
  infosoud: { name: null, description: "catalogue.toolDescriptions.infosoud" },
  krs: { name: null, description: "catalogue.toolDescriptions.krs" },
  orsr: { name: null, description: "catalogue.toolDescriptions.orsr" },
  prh: { name: null, description: "catalogue.toolDescriptions.prh" },
  "recherche-entreprises": {
    name: null,
    description: "catalogue.toolDescriptions.rechercheEntreprises",
  },
  rpo: { name: null, description: "catalogue.toolDescriptions.rpo" },
  vies: {
    name: "catalogue.toolNames.vies",
    description: "catalogue.toolDescriptions.vies",
  },
  "web-search": {
    name: "catalogue.toolNames.webSearch",
    description: "catalogue.toolDescriptions.webSearch",
  },
} as const satisfies Record<NativeToolSlug, NativeToolCopy>;

type CatalogueEntryIdentity = { slug: string; kind: string };

const isNativeToolSlug = (slug: string): slug is NativeToolSlug =>
  Object.hasOwn(NATIVE_TOOL_COPY, slug);

// `undefined` for anything else in the catalogue (MCP servers, skills) and for
// a native tool this build does not ship.
const nativeToolCopy = ({
  kind,
  slug,
}: CatalogueEntryIdentity): NativeToolCopy | undefined =>
  kind === "native-tool" && isNativeToolSlug(slug)
    ? NATIVE_TOOL_COPY[slug]
    : undefined;

/** The key of a native tool's name; `undefined` keeps the manifest's name. */
export const nativeToolLabelKey = (
  entry: CatalogueEntryIdentity,
): NativeToolNameKey | undefined => nativeToolCopy(entry)?.name ?? undefined;

/** The key of a native tool's description; `undefined` keeps the given text. */
export const nativeToolDescriptionKey = (
  entry: CatalogueEntryIdentity,
): NativeToolDescriptionKey | undefined => nativeToolCopy(entry)?.description;

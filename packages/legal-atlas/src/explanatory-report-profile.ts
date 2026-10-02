import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";

import type { ProvisionLevelKey } from "./provision-citation-grammars";

export type ExplanatoryStructure =
  | "part"
  | "chapter"
  | "annex"
  | "article"
  | "opening_sentence";
export const AMENDMENT_OPERATIONS = [
  "replace",
  "insert",
  "delete",
  "renumber",
] as const;
export type AmendmentOperation = (typeof AMENDMENT_OPERATIONS)[number];
export type ExplanatoryReportProfile = {
  status: "supported";
  prefix: string;
  printPrefix: string;
  connector: string;
  range: string;
  article: string;
  amendmentPoint: string;
  instructionPrefix: string;
  instructionBoundary: string;
  insertedPrefix: string;
  numberPrefix: string;
  contentBoundary: string;
  insertionTail: string;
  quotes: readonly { open: string; close: string }[];
  ordinals: Readonly<Record<string, number>>;
  levels: readonly {
    key: ProvisionLevelKey;
    marker: string;
    value: string;
    print: string;
  }[];
  structures: readonly {
    kind: ExplanatoryStructure;
    marker: string;
    value: "ordinal" | "number" | "none";
  }[];
  operations: Readonly<Record<AmendmentOperation, string>>;
  renumber: string;
};

/** Normalize keyword spelling without rewriting identity-bearing values in the input. */
export const explanatoryPattern = (source: string, flags: string): RegExp =>
  new RegExp(
    source.replace(/\p{L}/gu, (letter) => {
      const decomposed = letter.normalize("NFD");
      return decomposed === letter ? letter : `(?:${letter}|${decomposed})`;
    }),
    flags,
  );

const CZ_EXPLANATORY_REPORT_PROFILE = {
  status: "supported",
  prefix: String.raw`K\s+`,
  printPrefix: "K ",
  connector: String.raw`(?:,|a(?=\s))`,
  range: String.raw`(?:až|[–-])`,
  article: String.raw`čl\.`,
  amendmentPoint: String.raw`bod(?:ům|u|y)?`,
  instructionPrefix: String.raw`(?:(?:V|Za|Před|Nadpis)\s+)?`,
  instructionBoundary: String.raw`\s+(?:se\s+|zní(?![\p{L}\p{N}]))`,
  insertedPrefix: String.raw`^(?:nov(?:ý|á|é)\s+)?`,
  numberPrefix: String.raw`^\d+\.\s+`,
  contentBoundary: String.raw`,\s+kter(?:é|á|ý)\s+zn(?:í|ějí)`,
  insertionTail: String.raw`^(?:[,.:]|$)`,
  quotes: [
    { open: "„", close: "“" },
    { open: '"', close: '"' },
  ],
  ordinals: Object.fromEntries(
    [
      ["první"],
      ["druhé", "druhá"],
      ["třetí"],
      ["čtvrté", "čtvrtá"],
      ["páté", "pátá"],
      ["šesté", "šestá"],
      ["sedmé", "sedmá"],
      ["osmé", "osmá"],
      ["deváté", "devátá"],
      ["desáté", "desátá"],
    ].flatMap((spellings, index) =>
      spellings.map((spelling) => [spelling, index + 1] as const),
    ),
  ),
  levels: [
    {
      key: "section",
      marker: "§§?",
      value: String.raw`\d+[a-zA-Z]?`,
      print: "§",
    },
    {
      key: "subsection",
      marker: String.raw`(?:odst\.|odstav(?:ec|ce|ci|ců))`,
      value: String.raw`\d+[a-zA-Z]?`,
      print: "odst.",
    },
    {
      key: "letter",
      marker: String.raw`(?:písm\.|písmen(?:o|a|u))`,
      value: String.raw`[a-zA-Z]\)?`,
      print: "písm.",
    },
    {
      key: "point",
      marker: String.raw`bod(?:u|ě|y|ů)?`,
      value: String.raw`\d+`,
      print: "bod",
    },
  ],
  structures: [
    { kind: "part", marker: "části", value: "ordinal" },
    { kind: "chapter", marker: "hlavě", value: "ordinal" },
    {
      kind: "annex",
      marker: String.raw`příloh(?:ám|a|e|ě)(?:\s+č\.)?`,
      value: "number",
    },
    { kind: "opening_sentence", marker: "úvodní větě", value: "none" },
  ],
  operations: {
    replace: String.raw`(?<![\p{L}\p{N}])(?:nahrazuje|nahrazují|zní)(?![\p{L}\p{N}])`,
    insert: String.raw`(?<![\p{L}\p{N}])(?:vkládá|vkládají|doplňuje|doplňují)(?![\p{L}\p{N}])`,
    delete: String.raw`(?<![\p{L}\p{N}])(?:zrušuje|zrušují|vypouští)(?![\p{L}\p{N}])`,
    renumber: String.raw`(?<![\p{L}\p{N}])(?:označuje|označují)\s+jako(?![\p{L}\p{N}])`,
  },
  renumber: String.raw`^Dosavadní\s+(?<level>odstavce|písmena|body)\s+(?<from>.+?)\s+se\s+označují\s+jako\s+(?<toLevel>odstavce|písmena|body)\s+(?<to>.+?)\.?$`,
} as const satisfies ExplanatoryReportProfile;

const unsupported = { status: "unsupported" } as const;
export const EXPLANATORY_REPORT_PROFILES = {
  AUT: unsupported,
  CZE: CZ_EXPLANATORY_REPORT_PROFILE,
  EU: unsupported,
  HUN: unsupported,
  POL: unsupported,
  SVK: unsupported,
  USA: unsupported,
} as const satisfies Record<
  CaseLawJurisdiction,
  ExplanatoryReportProfile | { status: "unsupported" }
>;

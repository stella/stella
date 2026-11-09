import { panic } from "better-result";

import type { GuidanceKind } from "@stll/legal-ast/document-kind";

import { isCapabilityRoute } from "@/api/lib/capability-route";

import type { SoftLawAuthority } from "./soft-law-types";

/** How far a source's documents may be served to people. */
export const SOFT_LAW_SERVE_MODE = {
  full: "full",
  /** Title, issuer, date, reference, kind and publisher URL; no document text. */
  metadataLink: "metadata_link",
  none: "none",
} as const;

/**
 * How far a source's text may reach a model. `reading` covers a model the
 * caller connected through MCP, reading a passage to answer that caller;
 * `generation` also covers text stella's own model produces from the source,
 * including in-app chat answers and generated summaries.
 */
export const SOFT_LAW_AI_USE = {
  none: "none",
  reading: "reading",
  generation: "generation",
} as const;

type SoftLawAiUse = (typeof SOFT_LAW_AI_USE)[keyof typeof SOFT_LAW_AI_USE];

/** The attribution a result from this source carries on every surface. */
type SoftLawAttribution = {
  /** Shown verbatim beside the document, or `null` when none is stated. */
  text: string;
  /** Where the publisher states its reuse terms, or `null` when it does not. */
  termsUrl: string | null;
  /** Conditions the publisher attaches to reuse, shown with the attribution. */
  conditions: readonly string[];
  /** Disclaimer the publisher requires on transformed text, shown with summaries. */
  summaryDisclaimer: string | null;
};

export type SoftLawServingSetting =
  | { serve: typeof SOFT_LAW_SERVE_MODE.none }
  | {
      serve: typeof SOFT_LAW_SERVE_MODE.metadataLink;
      attribution: SoftLawAttribution;
    }
  | {
      serve: typeof SOFT_LAW_SERVE_MODE.full;
      ai: SoftLawAiUse;
      attribution: SoftLawAttribution;
      /** Kinds withheld from every surface until a personal-data check clears them. */
      withheldKinds: readonly GuidanceKind[];
    };

const notServed = {
  serve: SOFT_LAW_SERVE_MODE.none,
} as const satisfies SoftLawServingSetting;

/**
 * One reviewed decision per source. The read path consults only this map:
 * the descriptor stored on `soft_law_sources` records what a sync registered
 * and never grants access. A key for a source no adapter serves yet (a held
 * entry) is the decision waiting for that adapter.
 */
export const SOFT_LAW_SERVING_SETTINGS = {
  "cz-uoou": {
    serve: SOFT_LAW_SERVE_MODE.full,
    ai: SOFT_LAW_AI_USE.generation,
    attribution: {
      text: "Úřad pro ochranu osobních údajů, uoou.gov.cz",
      termsUrl: null,
      conditions: [],
      summaryDisclaimer: null,
    },
    withheldKinds: ["inspection_report", "other"],
  },
  "cz-suip": {
    serve: SOFT_LAW_SERVE_MODE.full,
    ai: SOFT_LAW_AI_USE.generation,
    attribution: {
      text: "Státní úřad inspekce práce, suip.gov.cz",
      termsUrl: null,
      conditions: [],
      summaryDisclaimer: null,
    },
    withheldKinds: ["inspection_report", "other"],
  },
  "eu-edpb": {
    serve: SOFT_LAW_SERVE_MODE.full,
    ai: SOFT_LAW_AI_USE.generation,
    attribution: {
      text: "European Data Protection Board, edpb.europa.eu",
      termsUrl: "https://www.edpb.europa.eu/copyright_en",
      conditions: [
        "Acknowledge the European Data Protection Board as the source.",
        "Do not distort the original meaning or message of the document.",
      ],
      summaryDisclaimer: null,
    },
    withheldKinds: [],
  },
  "eu-wp29": notServed,
  "at-dsb": notServed,
  "be-apd": notServed,
  "bg-cpdp": notServed,
  "hr-azop": notServed,
  "cy-dpa": notServed,
  "dk-datatilsynet": notServed,
  "ee-aki": notServed,
  "fi-ombudsman": notServed,
  "fr-cnil": notServed,
  "de-bfdi": notServed,
  "el-hdpa": notServed,
  "hu-naih": notServed,
  "is-personuvernd": notServed,
  "ie-dpc": notServed,
  "it-garante": notServed,
  "lv-dvi": notServed,
  "li-dss": notServed,
  "lt-vdai": notServed,
  "lu-cnpd": notServed,
  "mt-idpc": notServed,
  "nl-ap": notServed,
  "no-datatilsynet": notServed,
  "pl-uodo": notServed,
  "pt-cnpd": notServed,
  "ro-anspdcp": notServed,
  "sk-uoou": notServed,
  "si-ip": notServed,
  "es-aepd": notServed,
  "se-imy": notServed,
  "eu-edps": notServed,
  "de-dsk": notServed,
  "de-bw": notServed,
  "de-by-baylfd": notServed,
  "de-by-baylda": notServed,
  "de-be": notServed,
  "de-bb": notServed,
  "de-hb": notServed,
  "de-hh": notServed,
  "de-he": notServed,
  "de-mv": notServed,
  "de-ni": notServed,
  "de-nw": notServed,
  "de-rp": notServed,
  "de-sl": notServed,
  "de-sn": notServed,
  "de-st": notServed,
  "de-sh": notServed,
  "de-th": notServed,
  "es-apdcat": notServed,
  "es-avpd": notServed,
  "es-ctpd": notServed,
  "at-pdk": notServed,
  "be-vtc": notServed,
  "be-coc": notServed,
  "be-comitei": notServed,
  "be-comitep": notServed,
} as const satisfies Record<SoftLawAuthority, SoftLawServingSetting>;

export const hasSoftLawSetting = (
  authority: string,
): authority is SoftLawAuthority =>
  Object.hasOwn(SOFT_LAW_SERVING_SETTINGS, authority);

/**
 * The setting of a stored document's authority. A value this deployment does
 * not know (a row written by a newer release, or a stray value) has no
 * explicit setting, so it is not served.
 */
export const softLawServingSettingOf = (
  authority: string,
): SoftLawServingSetting =>
  hasSoftLawSetting(authority)
    ? SOFT_LAW_SERVING_SETTINGS[authority]
    : notServed;

/** Whether a source may reach this surface with text, metadata only, or not at all. */
export const SOFT_LAW_READ_SURFACE = {
  /** A person reading through the API or the web reader. */
  people: "people",
  /** A model the caller connected through MCP or the CLI. */
  mcp: "mcp",
  /** stella's own in-app chat model. */
  chat: "chat",
} as const;

export type SoftLawReadSurface =
  (typeof SOFT_LAW_READ_SURFACE)[keyof typeof SOFT_LAW_READ_SURFACE];

/** A capability call serves a connected model; every other route serves a person. */
export const softLawSurfaceOfRoute = (route: string): SoftLawReadSurface =>
  isCapabilityRoute(route)
    ? SOFT_LAW_READ_SURFACE.mcp
    : SOFT_LAW_READ_SURFACE.people;

export type SoftLawAccess = "text" | "metadata" | "none";

const AI_USE_TEXT_ON_SURFACE = {
  mcp: { none: false, reading: true, generation: true },
  chat: { none: false, reading: false, generation: true },
} as const satisfies Record<
  Exclude<SoftLawReadSurface, "people">,
  Record<SoftLawAiUse, boolean>
>;

const textOnSurface = (ai: SoftLawAiUse, surface: SoftLawReadSurface) =>
  surface === SOFT_LAW_READ_SURFACE.people ||
  AI_USE_TEXT_ON_SURFACE[surface][ai];

/**
 * What one document may do on one surface. Every read path, snippet and
 * search filter asks this, so a new surface or mode cannot widen access in
 * one place only.
 */
export const softLawAccessOf = (
  setting: SoftLawServingSetting,
  options: { surface: SoftLawReadSurface; kind: string },
): SoftLawAccess => {
  switch (setting.serve) {
    case SOFT_LAW_SERVE_MODE.none:
      return "none";
    case SOFT_LAW_SERVE_MODE.metadataLink:
      return "metadata";
    case SOFT_LAW_SERVE_MODE.full: {
      if (setting.withheldKinds.some((withheld) => withheld === options.kind)) {
        return "none";
      }
      return textOnSurface(setting.ai, options.surface) ? "text" : "metadata";
    }
    default:
      setting satisfies never;
      return panic("Unhandled soft-law serve mode");
  }
};

/** The flags a sync stores on the source row, so the row cannot contradict its setting. */
export const softLawDescriptorFlags = (setting: SoftLawServingSetting) => ({
  allowsRedistribution: setting.serve === SOFT_LAW_SERVE_MODE.full,
  allowsDerivedAi:
    setting.serve === SOFT_LAW_SERVE_MODE.full &&
    setting.ai === SOFT_LAW_AI_USE.generation,
});

/** One served authority as a search filter sees it on one surface. */
type SoftLawSurfaceEntry = {
  authority: string;
  /** `text` authorities are matched and snippeted on their body too. */
  access: Exclude<SoftLawAccess, "none">;
  withheldKinds: readonly GuidanceKind[];
};

/**
 * The served authorities of one surface, for the search filter. A source
 * absent here is `none`; a `metadata` entry is matched on its title alone, so
 * a metadata-link source can never answer a query from its body.
 */
export const softLawSurfaceEntries = (
  surface: SoftLawReadSurface,
): readonly SoftLawSurfaceEntry[] => {
  const entries: SoftLawSurfaceEntry[] = [];
  // Widened on purpose: no source uses every mode today, and the switch must
  // still decide each one.
  const settings: Record<string, SoftLawServingSetting> =
    SOFT_LAW_SERVING_SETTINGS;
  for (const [authority, setting] of Object.entries(settings)) {
    switch (setting.serve) {
      case SOFT_LAW_SERVE_MODE.none:
        break;
      case SOFT_LAW_SERVE_MODE.metadataLink:
        entries.push({ authority, access: "metadata", withheldKinds: [] });
        break;
      case SOFT_LAW_SERVE_MODE.full:
        entries.push({
          authority,
          access: textOnSurface(setting.ai, surface) ? "text" : "metadata",
          withheldKinds: setting.withheldKinds,
        });
        break;
      default:
        setting satisfies never;
        panic("Unhandled soft-law serve mode");
    }
  }
  return entries;
};

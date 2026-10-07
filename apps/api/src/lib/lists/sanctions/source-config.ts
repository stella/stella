import { panic } from "better-result";

import { SANCTIONS_SOURCES } from "@stll/sanctions";
import type { SanctionsSource } from "@stll/sanctions";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const SANCTIONS_SOURCE_CONFIG = {
  eu: {
    allowedRedirectHosts: SANCTIONS_SOURCES["eu"].allowedRedirectHosts,
    issuer: "European Union",
    markerUrl:
      "https://data.europa.eu/api/hub/repo/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions",
    freshnessMs: 48 * HOUR_MS,
  },
  un: {
    allowedRedirectHosts: SANCTIONS_SOURCES["un"].allowedRedirectHosts,
    issuer: "United Nations",
    markerUrl: "https://scsanctions.un.org/resources/xml/en/consolidated.xml",
    freshnessMs: 48 * HOUR_MS,
  },
  cz: {
    allowedRedirectHosts: SANCTIONS_SOURCES["cz"].allowedRedirectHosts,
    issuer: "Czech Republic",
    markerUrl:
      "https://mzv.gov.cz/jnp/cz/o_ministerstvu/otevrena_data/index_5.html",
    freshnessMs: 14 * DAY_MS,
  },
  "us-sdn": {
    allowedRedirectHosts: SANCTIONS_SOURCES["us-sdn"].allowedRedirectHosts,
    issuer: "United States",
    markerUrl: SANCTIONS_SOURCES["us-sdn"].editionMarker.url,
    freshnessMs: 48 * HOUR_MS,
  },
  "us-non-sdn": {
    allowedRedirectHosts: SANCTIONS_SOURCES["us-non-sdn"].allowedRedirectHosts,
    issuer: "United States",
    markerUrl: SANCTIONS_SOURCES["us-non-sdn"].editionMarker.url,
    freshnessMs: 48 * HOUR_MS,
  },
  uk: {
    allowedRedirectHosts: SANCTIONS_SOURCES["uk"].allowedRedirectHosts,
    issuer: "United Kingdom",
    markerUrl: SANCTIONS_SOURCES.uk.editionMarker.url,
    freshnessMs: 48 * HOUR_MS,
  },
  ch: {
    allowedRedirectHosts: SANCTIONS_SOURCES["ch"].allowedRedirectHosts,
    issuer: "Switzerland",
    markerUrl: SANCTIONS_SOURCES.ch.editionMarker.url,
    freshnessMs: 48 * HOUR_MS,
  },
} as const satisfies Record<
  SanctionsSource,
  {
    issuer: string;
    markerUrl: string;
    freshnessMs: number;
    allowedRedirectHosts: readonly string[];
  }
>;

export const isSanctionsSource = (value: string): value is SanctionsSource =>
  Object.hasOwn(SANCTIONS_SOURCE_CONFIG, value);

export const sanctionsSourceIds = () => {
  const sources: SanctionsSource[] = [];
  for (const key of Object.keys(SANCTIONS_SOURCE_CONFIG)) {
    if (!isSanctionsSource(key)) {
      panic(`Unknown sanctions source config key: ${key}`);
    }
    sources.push(key);
  }
  const [first, ...rest] = sources;
  if (first === undefined) {
    panic("Sanctions source registry is empty");
  }
  return [first, ...rest] as const;
};

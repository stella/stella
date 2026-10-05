import { createHash } from "node:crypto";

import type { SanctionsEntry } from "../entry";

export const MONITORING_CONTACT_COUNT = 10_000;
export const MONITORING_ENTRY_COUNT = 20_000;

export const syntheticMonitoringName = (index: number) =>
  createHash("sha256")
    .update(`synthetic-person-${index}`)
    .digest("hex")
    .slice(0, 32)
    .replaceAll(/[0-9a-f]/gu, (hex) =>
      String.fromCodePoint(97 + Number.parseInt(hex, 16)),
    )
    .replace(/^(.{16})/u, "$1 ");

export const syntheticMonitoringEntry = (index: number) =>
  ({
    source: "eu",
    issuer: "EU",
    sourceId: String(index),
    referenceNumber: null,
    entityType: "person",
    names: [{ name: syntheticMonitoringName(index), quality: "strong" }],
    birthDates: [],
    nationalities: [],
    identifiers: [],
    addresses: [],
    programme: null,
    legalBasis: null,
    listedOn: null,
    sourceUrl: "https://example.test/entry",
  }) satisfies SanctionsEntry;

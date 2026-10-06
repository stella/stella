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

export const MONITORING_SCREENING_PASSES = 2;
export const MATCHER_REPORT_BATCH_SIZE = 100;
export const MATCHER_WORKLOAD_REPORT_COUNT =
  1 +
  (MONITORING_CONTACT_COUNT * MONITORING_SCREENING_PASSES) /
    MATCHER_REPORT_BATCH_SIZE;

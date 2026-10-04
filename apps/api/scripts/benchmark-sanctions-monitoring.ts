import { panic } from "better-result";
import { performance } from "node:perf_hooks";

import {
  buildScreeningIndex,
  DEFAULT_CUTOFF,
  SANCTIONS_SOURCES,
  screen,
} from "@stll/sanctions";
import type { SanctionsEntry } from "@stll/sanctions";

import { toSafeId } from "../src/lib/branded-types";
import { monitoringSubject } from "../src/lib/lists/sanctions/monitoring-input";
import { sanctionsSourceIds } from "../src/lib/lists/sanctions/source-config";

// Matcher throughput only: the scheduler's DB claim/commit cost is excluded.
// Full indices and complete results use the same matcher and cutoff as the
// shared screening service. Names are synthetic and never leave this process.
const CONTACT_COUNT = 10_000;
const ENTRY_COUNT = 20_000;
const NAME_PARTS = 997;
const syntheticName = (index: number) =>
  `Person${index % NAME_PARTS} Family${Math.floor(index / NAME_PARTS)}`;
const contacts = Array.from({ length: CONTACT_COUNT }, (_, index) =>
  monitoringSubject({
    id: toSafeId<"contact">(Bun.randomUUIDv7()),
    organizationId: toSafeId<"organization">("synthetic-org"),
    type: "person",
    displayName: syntheticName(index),
    organizationName: null,
    registrationNumber: null,
    taxId: null,
    dateOfBirthYear: null,
    dateOfBirthMonth: null,
    dateOfBirthDay: null,
    nationalityCodes: [],
    sanctionsMonitoringMode: "included",
  }),
);

for (const source of sanctionsSourceIds()) {
  const entries: SanctionsEntry[] = Array.from(
    { length: ENTRY_COUNT },
    (_, index) => ({
      source,
      issuer: SANCTIONS_SOURCES[source].issuer,
      sourceId: String(index),
      referenceNumber: null,
      entityType: "person",
      names: [{ name: syntheticName(index), quality: "strong" }],
      birthDates: [],
      nationalities: [],
      identifiers: [],
      addresses: [],
      programme: null,
      legalBasis: null,
      listedOn: null,
      sourceUrl: "https://example.test/synthetic",
    }),
  );
  const buildStart = performance.now();
  const index = buildScreeningIndex([
    { version: { source, publishedAt: "2026-09-29", fileId: null }, entries },
  ]);
  const buildMs = performance.now() - buildStart;
  const start = performance.now();
  let hits = 0;
  for (const subject of contacts) {
    const result = screen(
      index,
      { name: subject.name, entityType: "person" },
      { cutoff: DEFAULT_CUTOFF, limit: ENTRY_COUNT },
    );
    if (result.isErr()) {
      panic("Synthetic benchmark query rejected");
    }
    hits += result.value.totalMatches;
  }
  const seconds = (performance.now() - start) / 1000;
  console.log(
    JSON.stringify({
      source,
      contacts: CONTACT_COUNT,
      entries: ENTRY_COUNT,
      contactsPerSecond: Math.round(CONTACT_COUNT / seconds),
      seconds,
      buildMs,
      hits,
    }),
  );
}

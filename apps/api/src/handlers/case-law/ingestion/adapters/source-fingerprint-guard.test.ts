import { panic } from "better-result";
/**
 * Every registered case-law source writes `rawHash` as `sourceFingerprint`
 * over what it stores, or is listed in the shrink-only `drivers` section of
 * scripts/source-fingerprint-baseline.json with a reason.
 *
 * A new miss fails, and so does a listed row that now conforms: the baseline
 * only loses rows. `bun scripts/source-fingerprint-baseline.ts --write`
 * regenerates it through this suite (the census is written to the path in
 * SOURCE_FINGERPRINT_CENSUS_OUT instead of being asserted).
 */
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";

import { sha256Hex as hashContent } from "@stll/sha256/bun";

import { encodeSourceRawEnvelope } from "@/api/handlers/case-law/ingestion/adapter";
import { listSourceRegistrations } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import { sourceFingerprint } from "@/api/handlers/case-law/ingestion/source-fingerprint";
import { isRecord } from "@/api/lib/type-guards";
import {
  FINGERPRINT_FINDING_REASONS,
  fingerprintFinding,
  SOURCE_FINGERPRINT_DRIVERS,
  sourceFingerprintCensus,
} from "@/api/tests/helpers/source-fingerprint-census";

const BASELINE = new URL(
  "../../../../../../../scripts/source-fingerprint-baseline.json",
  import.meta.url,
);
const CENSUS_OUT = process.env["SOURCE_FINGERPRINT_CENSUS_OUT"];

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const recordedDrivers = async (): Promise<string[]> => {
  const baseline: unknown = await Bun.file(BASELINE).json();
  const drivers = isRecord(baseline) ? baseline["drivers"] : undefined;
  return isRecord(drivers)
    ? Object.keys(drivers).toSorted()
    : panic("The source fingerprint baseline has no drivers section");
};

test("every source registration has a fingerprint driver", () => {
  const drivers = new Map<string, readonly unknown[]>(
    Object.entries(SOURCE_FINGERPRINT_DRIVERS),
  );
  for (const { key } of listSourceRegistrations()) {
    expect(drivers.get(key)?.length ?? 0, key).toBeGreaterThan(0);
  }
});

test("every registration's rawHash is the fingerprint of what it stores, or a listed member", async () => {
  const rows = await sourceFingerprintCensus();
  const misses = rows.flatMap(({ key, finding }) =>
    finding.type === "covers"
      ? []
      : [{ key, reason: FINGERPRINT_FINDING_REASONS[finding.type] }],
  );
  if (CENSUS_OUT !== undefined) {
    writeFileSync(CENSUS_OUT, JSON.stringify(misses));
    return;
  }
  expect(
    misses.map(({ key }) => key),
    "New misses fail; a conforming row must leave the baseline (--write)",
  ).toEqual(await recordedDrivers());
}, 120_000);

// ── self-test: the check rejects identity hashes ──────────────────────────

const envelope = encodeSourceRawEnvelope({
  document: "<p>Rozsudek</p>",
  listing: '{"docket":"1 Azs 4/2026"}',
});

test("a hash over the docket and date is rejected", () => {
  const identity = {
    rawHash: hashContent("1 Azs 4/2026|2026-05-28"),
    sourceRaw: envelope,
  };
  expect(fingerprintFinding(identity).type).toBe("not-from-stored-bytes");
  // The stored document changes; the identity hash does not notice.
  const corrected = { ...identity, sourceRaw: envelope.replace("R", "P") };
  expect(corrected.rawHash).toBe(identity.rawHash);
  expect(fingerprintFinding(corrected).type).toBe("not-from-stored-bytes");
});

test("a hash that leaves out a stored object is rejected", () => {
  const sourceRawObjects = {
    "document-file": {
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      contentType: "application/pdf",
    },
  };
  expect(
    fingerprintFinding({
      rawHash: hashContent(envelope),
      sourceRaw: envelope,
      sourceRawObjects,
    }).type,
  ).toBe("objects-not-covered");
  expect(
    fingerprintFinding({
      rawHash: sourceFingerprint({ sourceRaw: envelope, sourceRawObjects }),
      sourceRaw: envelope,
      sourceRawObjects,
    }).type,
  ).toBe("covers");
});

test("a decision without envelope text is reported", () => {
  expect(fingerprintFinding({ rawHash: hashContent("x") }).type).toBe(
    "no-envelope",
  );
});

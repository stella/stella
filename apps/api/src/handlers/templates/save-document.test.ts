import { describe, expect, test } from "bun:test";

import type { FieldMeta } from "@/api/handlers/docx/types";

import { hasDerivedValueSource, hasLiveMarker } from "./save-document";

// The save handler prunes a manifest field when discovery no longer finds a
// live `{{marker}}` for it (a Studio edit can delete the marker without a
// separate field-delete). Lookup and composite fields are marker-backed, so
// they must be pruned once their last marker is gone — they are exempt only
// while a live base or keyed-format marker survives, not merely because they
// carry lookup/parts/format metadata. These pure tests pin that gating; the
// full save round-trip (DB + S3 + discovery) is an integration concern.

const lookupField = (path: string, keys: string[]): FieldMeta => ({
  path,
  lookup: {
    registry: "krs",
    formats: keys.map((key) => ({ key, template: "[company name]" })),
  },
});

const compositeField = (path: string): FieldMeta => ({
  path,
  parts: [{ key: "title", inputType: "text" }],
  format: "{{title}}",
});

describe("hasDerivedValueSource", () => {
  test("is true only for genuinely marker-less derived fields", () => {
    expect(hasDerivedValueSource({ path: "a", formula: "x + 1" })).toBe(true);
    expect(hasDerivedValueSource({ path: "a", condition: "x == 1" })).toBe(
      true,
    );
    expect(hasDerivedValueSource({ path: "a", aiPrompt: "draft it" })).toBe(
      true,
    );
    expect(hasDerivedValueSource({ path: "a", aiAdapt: true })).toBe(true);
  });

  test("is false for marker-backed lookup and composite fields", () => {
    // The prior fix exempted these unconditionally; they are marker-backed, so
    // the derived-source check must NOT cover them — pruning is gated on a live
    // marker via hasLiveMarker instead.
    expect(hasDerivedValueSource(lookupField("company", ["output_1"]))).toBe(
      false,
    );
    expect(hasDerivedValueSource(compositeField("signer"))).toBe(false);
    expect(hasDerivedValueSource({ path: "plain" })).toBe(false);
  });
});

describe("hasLiveMarker", () => {
  test("keeps a plain/composite field while its bare marker is present", () => {
    const discovered = new Set(["signer", "company"]);
    expect(hasLiveMarker(compositeField("signer"), discovered)).toBe(true);
    expect(hasLiveMarker({ path: "company" }, discovered)).toBe(true);
  });

  test("prunes a composite field once its bare marker is gone", () => {
    expect(hasLiveMarker(compositeField("signer"), new Set())).toBe(false);
  });

  test("keeps a top-level lookup while only its keyed marker survives", () => {
    // Discovery registers the bare path as the object-root of a keyed marker,
    // so deleting `{{company}}` but keeping `{{company.full}}` still reports
    // `company` as a discovered path; the field stays live.
    const discovered = new Set(["company"]);
    expect(
      hasLiveMarker(lookupField("company", ["output_1", "full"]), discovered),
    ).toBe(true);
  });

  test("keeps an each-loop lookup whose keyed marker outlives its bare path", () => {
    // Inside `{{#each companies}}` the field path is `companies.krs`. Deleting
    // `{{companies.krs}}` but keeping `{{companies.krs.full}}` leaves only the
    // keyed path discovered; gating on the bare path alone would wrongly prune.
    const discovered = new Set(["companies", "companies.krs.full"]);
    const field = lookupField("companies.krs", ["output_1", "full"]);
    expect(discovered.has(field.path)).toBe(false);
    expect(hasLiveMarker(field, discovered)).toBe(true);
  });

  test("prunes a lookup once both its bare and keyed markers are gone", () => {
    const field = lookupField("companies.krs", ["output_1", "full"]);
    expect(hasLiveMarker(field, new Set(["companies"]))).toBe(false);
  });
});

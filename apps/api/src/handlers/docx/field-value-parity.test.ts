/**
 * ANTI-DRIFT GUARD for the deterministic field-value transforms.
 *
 * The Studio live preview and the API fill engine must render every
 * deterministic field (composite, formula, date) to the BYTE-IDENTICAL string,
 * or the preview lies about the generated document. Both sides now render
 * through ONE dispatcher — `renderDeterministicFieldValue` in
 * `@stll/template-conditions`. This test pins that contract: for a
 * representative set of fields + sample values, the value the API fill pipeline
 * (`applyManifestFillSteps`) writes at each field's path MUST equal what the
 * shared dispatcher returns.
 *
 * If someone later changes an API transform (composite-fields.ts /
 * formula-fields.ts / date-fields.ts) without updating the shared dispatcher
 * — reintroducing drift — this test fails. Lookup and AI fields are excluded
 * on purpose: they are non-deterministic / server-only and the dispatcher
 * does not handle them.
 */

import { describe, expect, test } from "bun:test";

import {
  renderDeterministicFieldValue,
  resolvePath,
} from "@stll/template-conditions";

import type { LookupResolver } from "./lookup-fields";
import { applyManifestFillSteps } from "./manifest-fill-steps";
import type { FieldMeta } from "./types";

// Lookup is out of scope (server-only). No deterministic field below uses it,
// so the resolver is never invoked; it errors loudly if a future case adds a
// lookup field without revisiting this guard.
const noLookup: LookupResolver = () => {
  throw new Error("lookup resolver must not run in the parity guard");
};

type ParityCase = {
  name: string;
  field: FieldMeta;
  values: Record<string, unknown>;
};

const cases: ParityCase[] = [
  {
    name: "composite (parts + format)",
    field: {
      path: "lawyer",
      parts: [
        { key: "position", inputType: "select", options: ["rad. praw."] },
        { key: "name", inputType: "text" },
      ],
      format: "{{position}} {{name}}",
    },
    values: { lawyer: { position: "rad. praw.", name: "Jan Kowalski" } },
  },
  {
    name: "formula (arithmetic)",
    field: {
      path: "total",
      formula: "min(rent * (1 + index / 100), rent * 1.05)",
    },
    values: { rent: 10_000, index: 7 },
  },
  {
    name: "date — long",
    field: {
      path: "signed",
      inputType: "date",
      dateFormat: { locale: "cs", style: "long" },
    },
    values: { signed: "2028-06-13" },
  },
  {
    name: "date — medium",
    field: {
      path: "signed",
      inputType: "date",
      dateFormat: { locale: "de", style: "medium" },
    },
    values: { signed: "2028-06-13" },
  },
  {
    name: "date — short",
    field: {
      path: "signed",
      inputType: "date",
      dateFormat: { locale: "en", style: "short" },
    },
    values: { signed: "2028-06-13" },
  },
  {
    name: "date — iso (passthrough)",
    field: {
      path: "signed",
      inputType: "date",
      dateFormat: { locale: "pl", style: "iso" },
    },
    values: { signed: "2028-06-13" },
  },
];

describe("field-value parity: API fill pipeline === shared dispatcher", () => {
  for (const { name, field, values } of cases) {
    test(name, async () => {
      const expected = renderDeterministicFieldValue(field, values);
      expect(expected).not.toBeNull();

      // Fresh copy: the pipeline mutates values in place.
      const filled: Record<string, unknown> = structuredClone(values);
      const error = await applyManifestFillSteps({
        values: filled,
        manifest: { fields: [field] },
        resolveLookup: noLookup,
      });
      expect(error).toBeNull();

      expect(resolvePath(field.path, filled)).toBe(expected);
    });
  }
});

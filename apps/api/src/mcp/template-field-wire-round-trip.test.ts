/**
 * The describe -> configure fixed point. `list_templates` (detail mode) and
 * `create_template` serialize a stored field with
 * {@link toTemplateFieldWireInput}; `configure_template_fields` reads the same
 * object back with {@link toFieldMetaToolInput}. An agent that edits one
 * property of a described field and sends the whole entry back must not lose
 * the rest, so the pair has to be a fixed point over every field shape a
 * manifest can hold: one entry per `source` branch, plus the plain properties
 * that travel beside it.
 */
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import type { FieldMeta } from "@/api/lib/docx/types";
import { fieldMetaToolInputSchema } from "@/api/lib/docx/types";
import {
  DEFAULT_LOOKUP_FORMAT,
  toFieldMetaToolInput,
  toTemplateFieldWireInput,
} from "@/api/mcp/template-field-input";

/**
 * One stored field per shape the manifest can express. Keyed so a failure
 * names the shape rather than an array index.
 */
const MANIFEST_FIXTURE = {
  bare: { path: "signatory_name" },
  person_with_everything: {
    path: "governing_law",
    label: "Governing law",
    hint: "Pick the jurisdiction the contract names.",
    inputType: "select",
    options: ["Czech Republic", "Slovakia"],
    required: true,
    validation: {
      required: true,
      minLength: 1,
      maxLength: 500,
      min: 0,
      max: 10,
      pattern: "^.+$",
      minItems: 1,
      maxItems: 3,
    },
    optionsFrom: "jurisdiction",
  },
  date: {
    path: "signing_date",
    inputType: "date",
    dateFormat: { locale: "pl", style: "long" },
  },
  composite: {
    path: "property_address",
    parts: [
      { key: "street", inputType: "text", label: "Street" },
      {
        key: "city",
        inputType: "select",
        options: ["Praha", "Brno"],
        pattern: "^.+$",
      },
    ],
    format: "{{street}}, {{city}}",
  },
  ai_drafted: {
    path: "recitals",
    aiPrompt: "Draft the recitals from the parties and the subject matter.",
  },
  ai_drafted_seeing_document: {
    path: "summary",
    aiPrompt: "Summarize the agreement.",
    aiSeesDocument: true,
  },
  ai_adapted: { path: "obligation", aiAdapt: true },
  ai_adapted_seeing_document: {
    path: "warranty",
    aiAdapt: true,
    aiSeesDocument: true,
  },
  lookup: {
    path: "company",
    lookup: {
      registry: "ares",
      formats: [
        { key: "name", template: "[company name]" },
        { key: "address", template: "[address]" },
      ],
    },
  },
  contact_binding: {
    path: "client_name",
    source: { kind: "contact", field: "displayName" },
  },
  party_binding: {
    path: "opposing_name",
    source: {
      kind: "party",
      role: "opposing_party",
      field: "organizationName",
    },
  },
  matter_binding: {
    path: "matter_reference",
    source: { kind: "matter", field: "reference" },
  },
  attorney_binding: {
    path: "attorney_name",
    source: { kind: "attorney", ref: "lead", field: "name" },
  },
  firm_binding: { path: "firm_name", source: { kind: "firm", field: "name" } },
  formula: { path: "annual_rent", formula: "base_rent * 12" },
  condition: { path: "penalty_applies", condition: "amount > 1000" },
} as const satisfies Record<string, FieldMeta>;

describe("describe -> configure round trip", () => {
  test.each(Object.entries(MANIFEST_FIXTURE))(
    "%s survives a wire round trip unchanged",
    (_name, field: FieldMeta) => {
      const wire = toTemplateFieldWireInput(field);
      expect(toTemplateFieldWireInput(toFieldMetaToolInput(wire))).toEqual(
        wire,
      );
    },
  );

  test.each(Object.entries(MANIFEST_FIXTURE))(
    "%s parses as a manifest field the persisted schema accepts",
    (_name, field: FieldMeta) => {
      const parsed = toFieldMetaToolInput(toTemplateFieldWireInput(field));
      expect(v.safeParse(fieldMetaToolInputSchema, parsed).success).toBe(true);
      // Every persisted property the fixture declared survives the trip.
      expect(parsed).toMatchObject(field);
    },
  );

  test("a field with no derived source describes as the person branch", () => {
    expect(toTemplateFieldWireInput({ path: "signatory_name" }).source).toEqual(
      {
        type: "person",
      },
    );
  });

  test("describe never emits ai_adapt or ai_sees_document as their own keys", () => {
    const wire = toTemplateFieldWireInput({
      path: "recitals",
      aiPrompt: "Draft it.",
      aiSeesDocument: true,
    });
    expect(Object.keys(wire).sort()).toEqual(["path", "source"]);
    expect(wire.source).toEqual({
      type: "ai",
      prompt: "Draft it.",
      sees_document: true,
    });
  });

  test("a lookup that names no formats renders the company name", () => {
    const parsed = toFieldMetaToolInput({
      path: "company",
      source: { type: "lookup", registry: "krs" },
    });
    expect(parsed.lookup).toEqual({
      registry: "krs",
      formats: [DEFAULT_LOOKUP_FORMAT],
    });
  });

  test("describe reports a false ai_adapt as a person field, not an AI one", () => {
    // The describe payload defaults `aiAdapt`/`aiSeesDocument` to false for
    // every field; neither is a source on its own.
    expect(
      toTemplateFieldWireInput({
        path: "tenant_name",
        aiAdapt: false,
        aiSeesDocument: false,
      }).source,
    ).toEqual({ type: "person" });
  });
});

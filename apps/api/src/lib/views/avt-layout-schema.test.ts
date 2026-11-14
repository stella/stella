import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { VIEW_LAYOUT_TYPES } from "@stll/api-contract";

import {
  isAvtLayoutVisible,
  projectAvtViewInputSchemas,
  projectViewEligibility,
} from "@/api/lib/auth/feature-access/view-eligibility";
import type { JsonSchema } from "@/api/lib/json-schema/valibot-to-json-schema";
import { isRecord } from "@/api/lib/type-guards";
import {
  tCreateViewInputSchema,
  tUpdateViewBodySchema,
} from "@/api/lib/views-schema";
import { advertisedSchemas } from "@/api/mcp/advertised-schema";
import { compileWireSchema } from "@/api/tests/helpers/wire-json-schema";

const filesystem = {
  type: "filesystem",
  version: 1,
  filters: [],
  sorts: [],
  hiddenProperties: [],
  calculations: [],
};
const avt = { ...filesystem, type: "avt", listId: null };
const id = "019c0c90-0000-7000-8000-000000000103";

// The projection rewrites the advertised JSON Schema, so what it admits is
// read by a JSON Schema validator: the reading an agent's client applies.
// Route renderings keep their `x-` extension keywords, which are annotations.
const ajv = new Ajv({ allowUnionTypes: true, strict: false });
addFormats(ajv);

const accepts = (schema: JsonSchema, value: unknown): boolean => {
  const plain: unknown = structuredClone(schema);
  if (!isRecord(plain)) {
    return panic("Expected an object schema");
  }
  return compileWireSchema(ajv, plain)(value);
};

describe("conditional view schema projection", () => {
  for (const [name, { config, ordinary, featured }] of Object.entries({
    create: {
      config: { body: tCreateViewInputSchema },
      ordinary: { id, name: "View", layout: filesystem },
      featured: { id, name: "View", layout: avt },
    },
    update: {
      config: { body: tUpdateViewBodySchema },
      ordinary: { name: "View", layout: filesystem },
      featured: { name: "View", layout: avt },
    },
    convert: {
      config: {
        body: v.object({ targetType: v.picklist([...VIEW_LAYOUT_TYPES]) }),
      },
      ordinary: { targetType: "filesystem" },
      featured: { targetType: "avt" },
    },
  })) {
    test(`${name} projection preserves ordinary inputs and removes AVT inputs`, () => {
      const full = advertisedSchemas(config);
      const projected = projectAvtViewInputSchemas(full);
      expect(projectAvtViewInputSchemas(projected)).toEqual(projected);
      expect(JSON.stringify(projected)).not.toContain('"avt"');
      if (full.body === undefined || projected.body === undefined) {
        panic("Expected body schemas");
      }
      // The route itself still admits both; only the advertisement narrows.
      expect(v.is(config.body, featured)).toBe(true);
      expect(accepts(full.body, featured)).toBe(true);
      expect(accepts(projected.body, featured)).toBe(false);
      expect(accepts(projected.body, ordinary)).toBe(true);
      if (name === "update") {
        expect(accepts(projected.body, { name: "View" })).toBe(true);
      }
    });
  }
});

test("AVT visibility follows the stored discriminator before layout recovery", () => {
  for (const layout of [{ type: "avt" }, { type: "avt", version: 0 }, avt]) {
    expect(isAvtLayoutVisible(layout, "unavailable")).toBe(false);
    expect(isAvtLayoutVisible(layout, "available")).toBe(true);
  }
  expect(isAvtLayoutVisible(filesystem, "unavailable")).toBe(true);
});

test("unavailable verification rows project identity before parsing or enrichment", () => {
  for (const layout of [{ type: "avt" }, { type: "avt", version: 0 }, avt]) {
    const view = { id, layout, name: "View", position: 4 };
    expect(
      projectViewEligibility({
        view,
        accessStatus: "unavailable",
        projectAvailable: () =>
          panic("Unavailable layouts must not be enriched"),
      }),
    ).toEqual({ id, eligibility: "unavailable" });
    expect(
      projectViewEligibility({
        view,
        accessStatus: "available",
        projectAvailable: (available) => available,
      }),
    ).toBe(view);
  }
  const ordinary = { id, layout: filesystem };
  expect(
    projectViewEligibility({
      view: ordinary,
      accessStatus: "unavailable",
      projectAvailable: (available) => available,
    }),
  ).toBe(ordinary);
});

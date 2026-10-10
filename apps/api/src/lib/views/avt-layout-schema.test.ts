import { Value } from "@sinclair/typebox/value";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { t } from "elysia";

import { VIEW_LAYOUT_TYPES } from "@stll/api-contract";

import {
  projectAvtViewInputSchemas,
  isAvtLayoutVisible,
  projectViewEligibility,
} from "@/api/lib/auth/feature-access/view-eligibility";
import {
  tCreateViewInputSchema,
  tUpdateViewBodySchema,
} from "@/api/lib/views-schema";
import { advertisedSchemas } from "@/api/mcp/advertised-schema";

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
        body: t.Object({ targetType: t.UnionEnum([...VIEW_LAYOUT_TYPES]) }),
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
      expect(Value.Check(full.body, featured)).toBe(true);
      expect(Value.Check(projected.body, featured)).toBe(false);
      expect(Value.Check(projected.body, ordinary)).toBe(true);
      if (name === "update") {
        expect(Value.Check(projected.body, { name: "View" })).toBe(true);
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

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { courtYearFixture, treemapFixture } from "./treemap-fixture";
import {
  createTreemapModel,
  treemapColorDomain,
  treemapCategoryValue,
  type VisualTreemapTree,
} from "./treemap-model";

const bucket = (id: string, count = 1) =>
  ({
    type: "bucket",
    id,
    label: id,
    count,
    citationSum: 0,
    treatment: null,
    tier: "other",
    court: "court",
    year: 2024,
  }) as const satisfies VisualTreemapTree;

describe("visual treemap hierarchy", () => {
  test("preserves court-year area and filter identity across zoom and back", () => {
    const model = createTreemapModel(treemapFixture);
    expect(model.visible().map(({ count }) => count)).toEqual([20, 5]);
    expect(model.visible().map(({ citationSum }) => citationSum)).toEqual([
      76, 45,
    ]);
    expect(model.visible().every(({ treatment }) => treatment === null)).toBe(
      true,
    );
    expect(model.back()).toBe(false);
    expect(model.select("CZ:ns").type).toBe("group");
    expect(model.root().id).toBe("CZ:ns");
    expect(model.visible().map(({ count }) => count)).toEqual([12, 8]);
    const selected = model.select("CZ:ns:2024");
    expect(selected).toMatchObject({
      type: "bucket",
      court: courtYearFixture[1].court,
      year: courtYearFixture[1].year,
    });
    expect(model.root().id).toBe("CZ:ns");
    expect(model.back()).toBe(true);
    expect(model.root()).toBe(treemapFixture);
    expect(model.back()).toBe(false);
    expect(() => model.select("CZ:ns:2024")).toThrow("visible level");
  });

  test("visual treemap conserves area and reverses every generated drill", () => {
    assertProperty(
      "visual treemap conserves area and reverses every generated drill",
      fc.property(
        fc.array(
          fc.array(
            fc.record({
              count: fc.integer({ min: 0, max: 100_000 }),
              citationSum: fc.option(fc.integer({ min: 0, max: 100_000 }), {
                nil: null,
              }),
              treatment: fc.option(fc.integer({ min: -1000, max: 1000 }), {
                nil: null,
              }),
            }),
            { minLength: 1, maxLength: 6 },
          ),
          { minLength: 1, maxLength: 8 },
        ),
        (groups) => {
          const tree = {
            type: "group",
            id: "root",
            label: "Root",
            children: groups.map((values, groupIndex) => ({
              type: "group",
              id: `group:${groupIndex}`,
              label: String(groupIndex),
              children: values.map((value, index) => ({
                type: "bucket",
                id: `${groupIndex}:${index}`,
                label: String(index),
                tier: "other",
                court: String(groupIndex),
                year: 2000 + index,
                ...value,
              })),
            })),
          } as const satisfies VisualTreemapTree;
          const model = createTreemapModel(tree);
          expect(model.visible().reduce((sum, row) => sum + row.count, 0)).toBe(
            groups.flat().reduce((sum, value) => sum + value.count, 0),
          );
          for (const row of model.visible()) {
            expect(row.node.type).toBe("group");
            if (row.count === 0) {
              continue;
            }
            const parent = model.root();
            model.select(row.node.id);
            expect(
              model.visible().reduce((sum, value) => sum + value.count, 0),
            ).toBe(row.count);
            expect(
              model.visible().some((value) => value.citationSum === null)
                ? null
                : model
                    .visible()
                    .reduce((sum, value) => sum + (value.citationSum ?? 0), 0),
            ).toBe(row.citationSum);
            const treatment = model
              .visible()
              .some((value) => value.treatment === null)
              ? null
              : model
                  .visible()
                  .reduce((sum, value) => sum + (value.treatment ?? 0), 0);
            expect(row.treatment).toBe(treatment);
            expect(model.back()).toBe(true);
            expect(model.root()).toBe(parent);
          }
        },
      ),
    );
  });

  test("uses sequential citations and symmetric signed treatment domains", () => {
    const model = createTreemapModel(treemapFixture);
    expect(treemapColorDomain(model.visible(), "citations")).toEqual([0, 76]);
    expect(treemapColorDomain(model.visible(), "treatment")).toEqual([0, 0]);
    const signed = createTreemapModel({
      type: "group",
      id: "root",
      label: "Root",
      children: [
        { ...bucket("negative"), treatment: -7 },
        { ...bucket("positive"), treatment: 3 },
      ],
    });
    expect(treemapColorDomain(signed.visible(), "treatment")).toEqual([-7, 7]);
    expect(treemapColorDomain(signed.visible(), "citations")).toEqual([0, 0]);
  });

  test("keeps category fields typed and unknown citation values neutral", () => {
    const leaf = { ...bucket("missing"), citationSum: null };
    const root = {
      type: "group",
      id: "root",
      label: "Root",
      tier: "other",
      children: [leaf, bucket("known")],
    } as const satisfies VisualTreemapTree;
    const model = createTreemapModel(root);
    expect(model.visible().map(({ citationSum }) => citationSum)).toEqual([
      null,
      0,
    ]);
    expect(treemapCategoryValue(root, "tier")).toBe("other");
    expect(treemapCategoryValue(leaf, "tier")).toBe("other");
    expect(treemapCategoryValue(root, "year")).toBeNull();
    expect(treemapCategoryValue(leaf, "year")).toBe("2024");
    expect(treemapCategoryValue(leaf, "citationSum")).toBeNull();
    for (const row of model.visible()) {
      expect(model.nodes()).toContain(row.node);
    }
  });

  test("accepts empty, zero-area and single-leaf trees", () => {
    const empty = createTreemapModel({
      type: "group",
      id: "empty",
      label: "Empty",
      children: [],
    });
    expect(empty.visible()).toEqual([]);
    expect(empty.back()).toBe(false);
    const leaf = createTreemapModel(bucket("one", 0));
    expect(leaf.visible().map(({ count }) => count)).toEqual([0]);
    expect(leaf.select("one")).toMatchObject({ type: "bucket" });
    expect(leaf.back()).toBe(false);
  });

  test("rejects invalid values, duplicate identities, cycles and excessive depth", () => {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createTreemapModel(bucket("bad", value))).toThrow(
        "values must be finite",
      );
      expect(() =>
        createTreemapModel({ ...bucket("bad"), citationSum: value }),
      ).toThrow("values must be finite");
    }
    expect(() =>
      createTreemapModel({ ...bucket("bad"), treatment: Number.NaN }),
    ).toThrow("values must be finite");
    expect(() =>
      createTreemapModel({
        type: "group",
        id: "root",
        label: "Root",
        children: [bucket("same"), bucket("same")],
      }),
    ).toThrow("unique identities");
    const children: VisualTreemapTree[] = [];
    const cyclic = {
      type: "group",
      id: "cycle",
      label: "Cycle",
      children,
    } as const;
    children.push(cyclic);
    expect(() => createTreemapModel(cyclic)).toThrow("acyclic hierarchy");
    let deep: VisualTreemapTree = bucket("leaf");
    for (let depth = 0; depth < 34; depth++) {
      deep = {
        type: "group",
        id: String(depth),
        label: String(depth),
        children: [deep],
      };
    }
    expect(() => createTreemapModel(deep)).toThrow("bounded acyclic hierarchy");
    expect(() =>
      createTreemapModel({
        type: "group",
        id: "large",
        label: "Large",
        children: Array.from({ length: 1024 }, (_, index) =>
          bucket(String(index)),
        ),
      }),
    ).toThrow("bounded acyclic hierarchy");
    expect(() =>
      createTreemapModel({
        type: "group",
        id: "overflow",
        label: "Overflow",
        children: [
          bucket("a", Number.MAX_VALUE),
          bucket("b", Number.MAX_VALUE),
        ],
      }),
    ).toThrow("aggregate values must be finite");
  });
});

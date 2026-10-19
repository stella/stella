import { expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  readPlaygroundInventory,
  replaySelection,
  selectGeometrySpecs,
} from "./ui-playground-selection";

const ROOT = path.resolve(import.meta.dirname, "..");

test("every geometry spec opens registered visuals with loader modules", () => {
  const inventory = readPlaygroundInventory(ROOT);
  expect(inventory.specs.length).toBeGreaterThan(0);
  expect(inventory.complete).toBe(true);
  for (const spec of inventory.specs) {
    const visuals = inventory.visualsBySpec.get(spec);
    expect(visuals?.size, spec).toBeGreaterThan(0);
    for (const visual of visuals ?? []) {
      expect(
        inventory.registeredVisuals.has(visual),
        `${spec}: ${visual}`,
      ).toBe(true);
      expect(inventory.loaderByVisual.has(visual), `${spec}: ${visual}`).toBe(
        true,
      );
    }
  }
});

test("selects loader, transitive, spec, and shared harness changes", () => {
  const inventory = readPlaygroundInventory(ROOT);
  const pageCrop = "apps/web/e2e/ui-playground/page-crop.geometry.spec.ts";
  const registry = "apps/web/e2e/ui-playground/registry.geometry.spec.ts";
  expect(
    selectGeometrySpecs(
      ["apps/web/src/routes/dev/-components/page-crop-playground.tsx"],
      ROOT,
    ),
  ).toEqual([pageCrop, registry]);
  expect(
    selectGeometrySpecs(
      ["apps/web/src/components/pdf/page-organizer-crop.logic.ts"],
      ROOT,
    ),
  ).toEqual([pageCrop, registry]);
  expect(selectGeometrySpecs(["apps/api/src/index.ts"], ROOT)).toEqual([]);
  expect(selectGeometrySpecs([pageCrop], ROOT)).toEqual([pageCrop]);
  expect(
    selectGeometrySpecs(
      ["apps/web/e2e/playwright.ui-playground.config.ts"],
      ROOT,
    ),
  ).toEqual(inventory.specs);
  expect(
    selectGeometrySpecs(["apps/web/e2e/ui-playground/README.md"], ROOT),
  ).toEqual(inventory.specs);
}, 30_000);

test("an incomplete visual mapping fails closed", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ui-playground-selection-"));
  try {
    const routeDirectory = "apps/web/src/routes/dev";
    const specDirectory = "apps/web/e2e/ui-playground";
    mkdirSync(path.join(root, routeDirectory), { recursive: true });
    cpSync(path.join(ROOT, specDirectory), path.join(root, specDirectory), {
      recursive: true,
    });
    for (const file of ["-visual-metadata.ts", "-visual-registry.tsx"]) {
      cpSync(
        path.join(ROOT, routeDirectory, file),
        path.join(root, routeDirectory, file),
      );
    }
    const registry = path.join(
      root,
      "apps/web/src/routes/dev/-visual-registry.tsx",
    );
    const source = readFileSync(registry, "utf-8");
    const mutated = source.replace(
      '  "page-crop": {',
      '  "page-crop-removed": {',
    );
    expect(mutated).not.toBe(source);
    writeFileSync(registry, mutated);
    const inventory = readPlaygroundInventory(root);
    expect(inventory.complete).toBe(false);
    expect(selectGeometrySpecs(["apps/api/src/index.ts"], root)).toEqual(
      inventory.specs,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("replay summarizes how many change sets select specs", () => {
  const harness = "apps/web/src/routes/dev/-visual-metadata.ts";
  const summary = replaySelection([[harness], ["README.md"]]);
  expect(summary.runs).toBe(2);
  expect(summary.selecting).toBe(1);
  expect(summary.meanSpecs).toBeGreaterThan(0);
});

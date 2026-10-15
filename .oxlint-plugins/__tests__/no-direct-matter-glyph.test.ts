import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("reports all restricted matter glyph spellings at their bindings", async () => {
  expect(
    await lintSingleRule(
      "no-direct-matter-glyph",
      'import { Layers, Layers2Icon, LucideLayers as Matter } from "lucide-react";\nimport { LayersIcon } from "@stll/ui/icons";',
    ),
  ).toEqual([1, 1, 1, 2]);
});

test("reports namespace and dynamically loaded matter glyphs", async () => {
  expect(
    await lintSingleRule(
      "no-direct-matter-glyph",
      'import * as icons from "lucide-react";\nconst matter = icons["Layers2"];\nconst { LayersIcon } = await import("@stll/ui/icons");',
    ),
  ).toEqual([2, 3]);
});

test("allows neutral glyphs and the owning matter component", async () => {
  expect(
    await lintSingleRule(
      "no-direct-matter-glyph",
      'import { FileIcon, Link } from "@stll/ui/icons";\nimport { MatterIcon } from "@stll/ui/matter-icon";',
    ),
  ).toEqual([]);
});

test("allows raw matter glyphs in their exact owner", async () => {
  expect(
    await lintSingleRule(
      "no-direct-matter-glyph",
      'import { Layers, LucideLayers2 } from "lucide-react";',
      {
        cwd: "scratch",
        sourcePath: "packages/ui/src/components/matter-icon.tsx",
      },
    ),
  ).toEqual([]);
});

test("keeps copies of the matter owner restricted", async () => {
  expect(
    await lintSingleRule(
      "no-direct-matter-glyph",
      'import { Layers } from "lucide-react";',
      {
        cwd: "scratch",
        sourcePath: "apps/web/src/components/matter-icon.copy.tsx",
      },
    ),
  ).toEqual([1]);
});

test("restricts every documented lucide glyph spelling outside its owner", async () => {
  expect(
    await lintSingleRule(
      "no-direct-matter-glyph",
      'import { Layers, LayersIcon, LucideLayers, Layers2, Layers2Icon, LucideLayers2 } from "lucide-react";',
    ),
  ).toEqual([1, 1, 1, 1, 1, 1]);
});

test("keeps the owner basename restricted in another directory", async () => {
  expect(
    await lintSingleRule(
      "no-direct-matter-glyph",
      'import { Layers } from "lucide-react";',
      { cwd: "scratch", sourcePath: "apps/web/src/other/matter-icon.tsx" },
    ),
  ).toEqual([1]);
});

test("keeps the former web owner restricted", async () => {
  expect(
    await lintSingleRule(
      "no-direct-matter-glyph",
      'import { LayersIcon } from "@stll/ui/icons";',
      { cwd: "scratch", sourcePath: "apps/web/src/components/matter-icon.tsx" },
    ),
  ).toEqual([1]);
});

import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("reports restricted folder and task glyph spellings at their bindings", async () => {
  expect(
    await lintSingleRule(
      "no-direct-entity-glyph",
      'import { Folder, FolderOpenIcon, LucideListTodo as Task } from "lucide-react";\nimport { FolderIcon } from "@stll/ui/icons";',
    ),
  ).toEqual([1, 1, 1, 2]);
});

test("reports namespace and dynamically loaded entity glyphs", async () => {
  expect(
    await lintSingleRule(
      "no-direct-entity-glyph",
      'import * as icons from "lucide-react";\nconst folder = icons["FolderOpen"];\nconst { ListTodoIcon } = await import("@stll/ui/icons");',
    ),
  ).toEqual([2, 3]);
});

test("allows neutral glyphs and the owning entity component", async () => {
  expect(
    await lintSingleRule(
      "no-direct-entity-glyph",
      'import { FileIcon, Mail, LinkIcon } from "@stll/ui/icons";\nimport { EntityKindIcon } from "@/components/workspaces/entity-kind-icon";',
    ),
  ).toEqual([]);
});

test("allows raw entity glyphs in their exact owner", async () => {
  expect(
    await lintSingleRule(
      "no-direct-entity-glyph",
      'import { Folder, ListTodoIcon } from "lucide-react";',
      {
        cwd: "scratch",
        sourcePath: "apps/web/src/components/workspaces/entity-kind-icon.tsx",
      },
    ),
  ).toEqual([]);
});

test("keeps copies of the entity owner restricted", async () => {
  expect(
    await lintSingleRule(
      "no-direct-entity-glyph",
      'import { Folder } from "lucide-react";',
      {
        cwd: "scratch",
        sourcePath:
          "apps/web/src/components/workspaces/entity-kind-icon.copy.tsx",
      },
    ),
  ).toEqual([1]);
});

test("restricts every documented lucide glyph spelling outside its owner", async () => {
  expect(
    await lintSingleRule(
      "no-direct-entity-glyph",
      'import { Folder, FolderIcon, LucideFolder, FolderOpen, FolderOpenIcon, LucideFolderOpen, ListTodo, ListTodoIcon, LucideListTodo } from "lucide-react";',
    ),
  ).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
});

test("keeps the owner basename restricted in another directory", async () => {
  expect(
    await lintSingleRule(
      "no-direct-entity-glyph",
      'import { Folder } from "lucide-react";',
      { cwd: "scratch", sourcePath: "apps/web/src/other/entity-kind-icon.tsx" },
    ),
  ).toEqual([1]);
});

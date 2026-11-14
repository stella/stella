import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseSource } from "../../packages/scripts/src/syntax-tree.ts";
import {
  ICON_MODULE_PATH,
  parseIconEntries,
  readIconEntries,
} from "../icon-ownership.ts";
import { lintSingleRule } from "./lint-single-rule";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");
const ICON_SOURCE = readFileSync(
  path.join(REPOSITORY_ROOT, ICON_MODULE_PATH),
  "utf-8",
);
const owned = readIconEntries().flatMap((entry) =>
  entry.owner === null ? [] : [{ ...entry, owner: entry.owner }],
);

// The generated plain re-export block at the bottom of the icon module.
const plainBlock = ICON_SOURCE.slice(
  ICON_SOURCE.indexOf("// @generated-start"),
);
// Whether `source` (the file at repo path `file`) has a value import of
// `name` from the icon module, read from its import declarations so a
// comment or a string that mentions the name does not count.
const importsFromIconModule = (
  file: string,
  source: string,
  name: string,
): boolean => {
  const iconModule = ICON_MODULE_PATH.replace(/\.ts$/u, "");
  return parseSource(file, source).module.staticImports.some((statement) => {
    const specifier = statement.moduleRequest.value;
    const fromIconModule =
      specifier === "@stll/ui/icons" ||
      (specifier.startsWith(".") &&
        path.posix
          .join(path.posix.dirname(file), specifier)
          .replace(/\.ts$/u, "") === iconModule);
    return (
      fromIconModule &&
      statement.entries.some(
        // A named import records the exported name it binds.
        ({ importName, isType }) => !isType && importName.name === name,
      )
    );
  });
};

const glyphBase = (glyph: string): string =>
  glyph.replace(/^Lucide/u, "").replace(/Icon$/u, "");

describe("icon ownership in packages/ui/src/icons.ts", () => {
  test("declares at least the copy glyph as owned by CopyButton", () => {
    expect(
      owned.map((entry) => [entry.name, entry.owner.component]),
    ).toContainEqual(["CopyToClipboardIcon", "CopyButton"]);
  });

  for (const entry of owned) {
    test(`${entry.name}: the owner exists, imports it, and the glyph has no plain export`, () => {
      const ownerFile = path.join(REPOSITORY_ROOT, entry.owner.path);
      expect(existsSync(ownerFile)).toBe(true);
      const ownerSource = readFileSync(ownerFile, "utf-8");
      expect(
        importsFromIconModule(entry.owner.path, ownerSource, entry.name),
      ).toBe(true);
      expect(ownerSource).toMatch(
        new RegExp(`export const ${entry.owner.component}\\b`, "u"),
      );
      const base = glyphBase(entry.glyph);
      for (const spelling of [base, `${base}Icon`, `Lucide${base}`]) {
        expect(plainBlock).not.toMatch(new RegExp(`\\b${spelling},`, "u"));
      }
    });

    test(`${entry.name}: the rule reports it outside its owner`, async () => {
      expect(
        await lintSingleRule(
          "no-unowned-icon",
          `import { ${entry.name} } from "@stll/ui/icons";\nexport const Glyph = ${entry.name};`,
          {
            cwd: "scratch",
            sourcePath: "apps/web/src/components/somewhere.tsx",
          },
        ),
      ).toEqual([1]);
    });

    test(`${entry.name}: the rule allows it in its owner`, async () => {
      expect(
        await lintSingleRule(
          "no-unowned-icon",
          `import { ${entry.name} } from "@stll/ui/icons";\nexport const Glyph = ${entry.name};`,
          { cwd: "scratch", sourcePath: entry.owner.path },
        ),
      ).toEqual([]);
    });
  }

  test("reports namespace, dynamic and re-exported reads of an owned entry", async () => {
    expect(
      await lintSingleRule(
        "no-unowned-icon",
        [
          'import * as icons from "@stll/ui/icons";',
          "const viaNamespace = icons.CopyToClipboardIcon;",
          'const { CopyToClipboardIcon } = await import("@stll/ui/icons");',
          'export { CopyToClipboardIcon as Reexported } from "@stll/ui/icons";',
        ].join("\n"),
      ),
    ).toEqual([2, 3, 4]);
  });

  test("reports a renamed import and a star re-export outside the owner", async () => {
    expect(
      await lintSingleRule(
        "no-unowned-icon",
        [
          'import { CopyToClipboardIcon as Glyph } from "@stll/ui/icons";',
          'export * from "@stll/ui/icons";',
          "export const Used = Glyph;",
        ].join("\n"),
      ),
    ).toEqual([1, 2]);
  });

  test("allows the other entries that share the glyph", async () => {
    expect(
      await lintSingleRule(
        "no-unowned-icon",
        'import { CopyFromMenuIcon, DuplicateIcon } from "@stll/ui/icons";',
      ),
    ).toEqual([]);
  });
});

describe("parseIconEntries", () => {
  test("reads ownedBy only from the comment block directly above an entry", () => {
    const source = [
      "// Copying from a button.",
      "// ownedBy: CopyButton (packages/ui/src/components/copy-button.tsx)",
      'export { CopyIcon as CopyToClipboardIcon } from "lucide-react";',
      "// ownedBy: Stale (nowhere.tsx)",
      "",
      "// Duplicating an item.",
      'export { CopyIcon as DuplicateIcon } from "lucide-react";',
    ].join("\n");
    expect(parseIconEntries(source)).toEqual([
      {
        name: "CopyToClipboardIcon",
        glyph: "CopyIcon",
        owner: {
          component: "CopyButton",
          path: "packages/ui/src/components/copy-button.tsx",
        },
      },
      { name: "DuplicateIcon", glyph: "CopyIcon", owner: null },
    ]);
  });

  test("reads ownedBy after any comment indentation, so spacing cannot unown an icon", () => {
    for (const prefix of ["//ownedBy:", "//  ownedBy:", "//\townedBy:"]) {
      const source = [
        `${prefix} CopyButton (packages/ui/src/components/copy-button.tsx)`,
        'export { CopyIcon as CopyToClipboardIcon } from "lucide-react";',
      ].join("\n");
      expect(parseIconEntries(source)[0]?.owner).toEqual({
        component: "CopyButton",
        path: "packages/ui/src/components/copy-button.tsx",
      });
    }
  });

  test("fails on an ownership line that does not parse, so a typo cannot unown an icon", () => {
    for (const typo of [
      "// ownedby: CopyButton (packages/ui/src/components/copy-button.tsx)",
      "// ownedBy: CopyButton packages/ui/src/components/copy-button.tsx",
      "// Owned by CopyButton.",
    ]) {
      const source = [
        "// Copying from a button.",
        typo,
        'export { CopyIcon as CopyToClipboardIcon } from "lucide-react";',
      ].join("\n");
      expect(() => parseIconEntries(source)).toThrow(
        /malformed ownership line/u,
      );
    }
  });

  test("finds the owner's import by its declarations, not by a mention", () => {
    const file = "packages/ui/src/components/copy-button.tsx";
    expect(
      importsFromIconModule(
        file,
        'import { CheckIcon, CopyToClipboardIcon } from "../icons";',
        "CopyToClipboardIcon",
      ),
    ).toBe(true);
    expect(
      importsFromIconModule(
        file,
        '// CopyToClipboardIcon\nimport { CheckIcon } from "../icons";',
        "CopyToClipboardIcon",
      ),
    ).toBe(false);
  });
});

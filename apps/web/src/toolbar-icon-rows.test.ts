import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

// Toolbar rows that are icons only. A labelled text button in one of them
// unbalances the row (Upload documents and Edit pages once stood out this
// way); an action here is a `ToolbarIconAction` or an icon-sized Button.
const ICON_ONLY_ROWS: readonly string[] = [
  "routes/_protected.workspaces/$workspaceId/-components/matter-upload-action.tsx",
  "routes/_protected.workspaces/-components/pdf-viewer-controls.tsx",
];

const SOURCE = nodePath.resolve(import.meta.dir);

/** A Button sized for text rather than an icon. */
const TEXT_SIZED_BUTTON = /<Button\b[^>]*\bsize="(?:default|lg|sm|xs)"/gsu;

describe("icon-only toolbar rows", () => {
  test.each(ICON_ONLY_ROWS)("%s draws no text-sized button", (file) => {
    const source = readFileSync(nodePath.join(SOURCE, file), "utf-8");
    expect(source.match(TEXT_SIZED_BUTTON) ?? []).toEqual([]);
  });

  test("the check recognises a text-sized button", () => {
    expect(
      '<Button onClick={go} size="sm" variant="ghost">Edit</Button>'.match(
        TEXT_SIZED_BUTTON,
      ),
    ).toHaveLength(1);
    expect(
      '<Button size="icon-xs" tooltip="Print" variant="ghost" />'.match(
        TEXT_SIZED_BUTTON,
      ),
    ).toBeNull();
  });
});

import { expect, test } from "bun:test";
import codepoints from "lucide-static/font/codepoints.json";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../../..");
const read = (file: string) =>
  readFileSync(path.join(REPO_ROOT, file), "utf-8");

/** `icon: XIcon, id: "x"` pairs of the web's primary navigation. */
const webNavIcons = (): Map<string, string> =>
  new Map(
    [
      ...read("apps/web/src/components/workspace-primary-nav.ts").matchAll(
        /icon: (\w+),\s*id: "(\w+)"/gu,
      ),
    ].map(([, icon, id]) => [id ?? "", icon ?? ""]),
  );

/** lucide's glyph name for a component (`MessageSquareIcon` is `message-square`). */
const glyphOf = (component: string) =>
  component
    .replace(/Icon$/u, "")
    .replaceAll(/(?<=[a-z\d])(?=[A-Z])/gu, "-")
    .toLowerCase();

/** The glyph each tab draws, by route. */
const tabGlyphs = (): Map<string, string> => {
  const layout = read("apps/mobile/src/app/(tabs)/_layout.tsx");
  return new Map(
    [
      ...layout.matchAll(
        /Trigger name="(\w+)">[\s\S]*?VectorIcon[\s\S]*?name="([\w-]+)"/gu,
      ),
    ].map(([, route, glyph]) => [route ?? "", glyph ?? ""]),
  );
};

test("every tab draws a glyph the lucide font has", () => {
  const glyphs = tabGlyphs();
  expect([...glyphs.keys()].toSorted()).toEqual(
    ["index", "matters", "settings", "tasks"].toSorted(),
  );
  for (const glyph of glyphs.values()) {
    expect(Object.keys(codepoints)).toContain(glyph);
  }
});

test("the chat tab draws the web navigation's chat glyph", () => {
  expect(tabGlyphs().get("index")).toBe(
    glyphOf(webNavIcons().get("chat") ?? ""),
  );
});

test("the matters tab draws the web's matter glyph, lucide's layers", () => {
  expect(webNavIcons().get("matters")).toBe("MattersNavIcon");
  expect(read("packages/ui/src/components/matter-icon.tsx")).toContain(
    'import { LayersIcon } from "../icons";',
  );
  expect(tabGlyphs().get("matters")).toBe("layers");
});

test("the settings tab draws the web user menu's settings glyph", () => {
  expect(read("apps/web/src/components/sidebar-user-menu.tsx")).toContain(
    "<CogIcon />",
  );
  expect(tabGlyphs().get("settings")).toBe(glyphOf("CogIcon"));
});

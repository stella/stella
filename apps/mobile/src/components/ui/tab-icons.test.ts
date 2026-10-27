import { expect, test } from "bun:test";
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

const tabLayout = () => read("apps/mobile/src/app/(tabs)/_layout.tsx");

test("chat and matters tabs draw the web navigation's glyphs", () => {
  const web = webNavIcons();
  expect(web.get("chat")).toBe("MessageSquareIcon");
  expect(web.get("matters")).toBe("MattersNavIcon");
  for (const icon of [web.get("chat"), web.get("matters")]) {
    expect(tabLayout()).toContain(`<${icon ?? "?"} `);
  }
});

test("the settings tab draws the web user menu's settings glyph", () => {
  expect(read("apps/web/src/components/sidebar-user-menu.tsx")).toContain(
    "<CogIcon />",
  );
  expect(tabLayout()).toContain("<CogIcon ");
});

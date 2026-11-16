import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

// The pre-paint script runs before the module graph and the stylesheet load,
// so it carries background colours literally. They must match a named source:
// the light value is the theme's resolved `--background` (the mobile theme
// generator resolves theme.css to sRGB and CI keeps its output current), and
// the dark value is the pre-paint near-black the web pre-paint shares.

const REPO_ROOT = path.join(import.meta.dir, "../../..");
const read = (file: string) =>
  readFileSync(path.join(REPO_ROOT, file), "utf-8");

/** `#rgb` as `#rrggbb`, lower-cased, so equal colours compare equal. */
const fullHex = (hex: string) =>
  hex.replace(/^#(\w)(\w)(\w)$/u, "#$1$1$2$2$3$3").toLowerCase();

const prepaint = read("apps/desktop/src/mainview/public/prepaint-theme.js");
const [, prepaintDark = "", prepaintLight = ""] =
  /isDark \? "(#[0-9a-f]+)" : "(#[0-9a-f]+)"/iu.exec(prepaint) ?? [];

describe("desktop pre-paint background", () => {
  test("paints light windows with the theme's resolved background", () => {
    const themeLight = /light: \{[^}]*?background: "(#[0-9a-f]+)"/u.exec(
      read("apps/mobile/src/ui-theme.gen.ts"),
    )?.[1];

    expect(themeLight).toMatch(/^#[0-9a-f]{3,6}$/u);
    expect(fullHex(prepaintLight)).toBe(fullHex(themeLight ?? ""));
  });

  test("paints dark windows with the web pre-paint's near-black", () => {
    const webDark = /backgroundColor = "(#[0-9a-f]+)"/iu.exec(
      read("apps/web/public/prepaint-init.js"),
    )?.[1];

    expect(webDark).toMatch(/^#[0-9a-f]{3,6}$/u);
    expect(fullHex(prepaintDark)).toBe(fullHex(webDark ?? ""));
  });
});

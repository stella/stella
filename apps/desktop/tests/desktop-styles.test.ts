import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import { createServer, mergeConfig } from "vite";
import type { ViteDevServer } from "vite";

import desktopViteConfig from "../vite.config";
import { DESKTOP_WINDOW_SIZES } from "./desktop-window-sizes";

// The real stylesheet, compiled the way the app gets it: the desktop Vite
// config with its Tailwind plugin, which reports every file it scanned for
// class names as a dependency of the stylesheet.
const SOURCE_ROOT = path.join(import.meta.dirname, "../src");
const STYLESHEET = "/index.css?direct";

let server: ViteDevServer;
let css: string;
let scanned: Set<string>;

beforeAll(async () => {
  // Merged the way Vite merges inline options over a loaded config file.
  server = await createServer(
    mergeConfig(desktopViteConfig, {
      appType: "custom",
      configFile: false,
      logLevel: "silent",
      server: { hmr: false, middlewareMode: true, watch: null },
    }),
  );
  const result = await server.transformRequest(STYLESHEET);
  if (result === null) {
    throw new TypeError("The desktop stylesheet did not compile");
  }
  css = result.code;
  const stylesheet = await server.moduleGraph.getModuleByUrl(STYLESHEET);
  scanned = new Set(
    [...(stylesheet?.importedModules ?? [])].flatMap(({ file }) =>
      file === null ? [] : [file],
    ),
  );
});

afterAll(async () => {
  await server.close();
});

test("every view file of every window is scanned for class names", () => {
  const views = readdirSync(SOURCE_ROOT, {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
    .map((entry) => path.join(entry.parentPath, entry.name));
  const folders = new Set(views.map((view) => path.dirname(view)));

  // Every window's views live in their own folder; a new folder must not
  // need a line of its own before its classes exist.
  expect(folders.size).toBeGreaterThan(5);
  expect(views.filter((view) => !scanned.has(view))).toEqual([]);
});

test("the design system's pointer sizes apply at every desktop window's width", () => {
  // `Button` is h-9 for touch and `sm:h-8` for a pointer; the `sm:` rule's
  // media query decides which one a window gets.
  const startsAt = minimumWidthOf(String.raw`.sm\:h-8 {`);
  const narrowest = Math.min(
    ...Object.values(DESKTOP_WINDOW_SIZES).map(({ width }) => width),
  );
  expect(startsAt).toBeLessThanOrEqual(narrowest);
});

/** The `min-width` of the media query whose block holds `selector`, in px. */
function minimumWidthOf(selector: string): number {
  const at = css.indexOf(selector);
  expect(at).toBeGreaterThan(-1);
  for (const query of css.matchAll(
    /@media \(width >= ([\d.]+)(rem|px)\) \{/gu,
  )) {
    let depth = 0;
    let end = query.index + query[0].length;
    for (; end < css.length; end += 1) {
      if (css[end] === "{") {
        depth += 1;
      } else if (css[end] === "}") {
        if (depth === 0) {
          break;
        }
        depth -= 1;
      }
    }
    if (query.index < at && at < end) {
      return Number(query[1]) * (query[2] === "rem" ? 16 : 1);
    }
  }
  throw new TypeError(`${selector} is not inside a width query`);
}

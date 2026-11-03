import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { MATTER_SWATCHES, matterChromeStyle } from "@stll/ui/matter-colors";

import {
  appSidebarSurfaceOf,
  appSidebarSurfaceProps,
} from "./app-sidebar-surface";

const webSourceRoot = path.join(import.meta.dir, "..");
const SURFACE_OWNER = "components/app-sidebar-surface.ts";

const webSources = () =>
  [...new Glob("**/*.{ts,tsx,css}").scanSync({ cwd: webSourceRoot })].filter(
    (file) => !/\.(test|spec)\.tsx?$/u.test(file) && !file.endsWith(".gen.ts"),
  );

const readWebSource = (file: string) =>
  readFileSync(path.join(webSourceRoot, file), "utf-8");

describe("app sidebar surface", () => {
  test("paints the same tint as the frame's chrome rows for every matter", () => {
    const colors = [null, ...MATTER_SWATCHES.map((swatch) => `var(${swatch})`)];
    for (const color of colors) {
      expect(
        appSidebarSurfaceProps(appSidebarSurfaceOf(color)).style[
          "--app-sidebar-fill"
        ],
      ).toBe(matterChromeStyle(color)["--matter-sidebar-tint"]);
    }
  });

  test("no module but the owner styles the sidebar's inner panel or fill", () => {
    const offenders = webSources().filter(
      (file) =>
        file !== SURFACE_OWNER &&
        /sidebar-inner|--app-sidebar-fill/u.test(readWebSource(file)),
    );
    expect(offenders).toEqual([]);
  });

  test("every sidebar is painted through the owner, never by a class or style", () => {
    const sidebars = webSources().flatMap((file) =>
      [...readWebSource(file).matchAll(/<Sidebar\b([^>]*)>/gu)].map(
        ([, attributes = ""]) => ({ attributes, file }),
      ),
    );
    // `AppSidebar` and the signed-out `PublicSidebar`; fewer means the scan
    // stopped reaching them.
    expect(sidebars.map(({ file }) => file)).toEqual(
      expect.arrayContaining([
        "components/app-sidebar.tsx",
        "components/public-workspace-shell.tsx",
      ]),
    );
    const unpainted = sidebars
      .filter(
        ({ attributes }) =>
          !attributes.includes("{...appSidebarSurfaceProps(") ||
          /\b(className|style)=/u.test(attributes),
      )
      .map(({ file }) => file);
    expect(unpainted).toEqual([]);
  });
});

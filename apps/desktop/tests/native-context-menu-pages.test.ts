import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const MAINVIEW = path.join(import.meta.dir, "../src/mainview");

// Every window the desktop app opens loads one of these pages. A page that
// does not install the policy, itself or through main.tsx, lets an unhandled
// right-click open the webview's browser menu (reload, inspect, back).
test("every desktop page installs the native context-menu policy", () => {
  const pages = readdirSync(MAINVIEW).filter((name) => name.endsWith(".html"));
  expect(pages).toContain("index.html");
  const unprotected = pages.filter((name) => {
    const html = readFileSync(path.join(MAINVIEW, name), "utf-8");
    return (
      !html.includes('<script src="/main.tsx" type="module"></script>') &&
      !html.includes("installNativeContextMenuPolicy(document);")
    );
  });
  expect(unprotected).toEqual([]);
});

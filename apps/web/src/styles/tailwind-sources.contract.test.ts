import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Tailwind only emits the utilities it finds in its sources. A workspace
// package that renders class names but is not listed in `app.css` fails
// silently: every class it shares with the app keeps working, and only the
// ones unique to that package go missing.

const appDir = path.resolve(import.meta.dirname, "../..");
const packagesDir = path.resolve(appDir, "../../packages");
const appCss = readFileSync(path.join(appDir, "src/styles/app.css"), "utf-8");
const packageJson: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} = JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf-8"));

// Packages whose class names reach Tailwind another way: folio-react is
// scanned through its compiled output because its chrome ships as JS.
const SOURCED_ELSEWHERE = new Set(["folio-react"]);

const listFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });

const isDirectory = (dir: string): boolean => {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

const rendersClassNames = (packageName: string): boolean => {
  const srcDir = path.join(packagesDir, packageName, "src");
  if (!isDirectory(srcDir)) {
    return false;
  }
  return listFiles(srcDir).some(
    (file) =>
      file.endsWith(".tsx") &&
      !file.endsWith(".test.tsx") &&
      readFileSync(file, "utf-8").includes("className"),
  );
};

const workspaceUiPackages = Object.keys({
  ...packageJson.dependencies,
  ...packageJson.devDependencies,
})
  .filter((name) => name.startsWith("@stll/"))
  .map((name) => name.slice("@stll/".length))
  .filter((name) => !SOURCED_ELSEWHERE.has(name))
  .filter(rendersClassNames);

test("every workspace package that renders class names is a Tailwind source", () => {
  expect(workspaceUiPackages.length).toBeGreaterThan(0);
  for (const name of workspaceUiPackages) {
    expect(appCss).toContain(
      `@source "../../../../packages/${name}/src/**/*.{ts,tsx}";`,
    );
  }
});

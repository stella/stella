import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

// Reads rely on the app query client's defaults (the shared API retry among
// them): a route loader fetches without retries otherwise, so one busy or
// unreachable backend would reach the route's error page. Any other client
// in app code would silently drop those defaults. Test harnesses build their
// own clients on purpose. Found by scanning, so a new client cannot hide.
const SOURCE = nodePath.resolve(import.meta.dir, "..");
const OWNER = "lib/react-query.ts";
const CONSTRUCTION = /\bnew QueryClient\(/u;
const HARNESS = /from "@testing-library\//u;

const constructions = [
  ...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: SOURCE }),
].filter((file) => {
  if (/\.test\.tsx?$/u.test(file)) {
    return false;
  }
  return CONSTRUCTION.test(readFileSync(nodePath.join(SOURCE, file), "utf-8"));
});

describe("app query client ownership", () => {
  test("the scan finds the owner", () => {
    expect(constructions).toContain(OWNER);
  });

  test("app code builds query clients only through the owner", () => {
    const strays = constructions.filter(
      (file) =>
        file !== OWNER &&
        !HARNESS.test(readFileSync(nodePath.join(SOURCE, file), "utf-8")),
    );
    expect(strays).toEqual([]);
  });
});

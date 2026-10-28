import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SOURCE_DIRECTORY = path.resolve(import.meta.dirname, "../..");
const LEGACY_PATH = ["", "settings", "organization"].join("/");
const LEGACY_ROUTE_PREFIX = ["organization", ""].join(".");
const LEGACY_ROUTE_DIRECTORY = ["routes", "_protected.settings"].join("/");

test("the admin cutover removes all former organization routes and links", () => {
  const files = readdirSync(SOURCE_DIRECTORY, {
    recursive: true,
    encoding: "utf-8",
  }).filter((file) => /\.(?:tsx?|json)$/u.test(file));
  expect(files.length).toBeGreaterThan(0);
  const staleLinks = files.filter((file) =>
    readFileSync(path.join(SOURCE_DIRECTORY, file), "utf-8").includes(
      LEGACY_PATH,
    ),
  );
  const staleRoutes = files.filter(
    (file) =>
      path.dirname(file) === LEGACY_ROUTE_DIRECTORY &&
      path.basename(file).startsWith(LEGACY_ROUTE_PREFIX),
  );
  expect(staleLinks).toEqual([]);
  expect(staleRoutes).toEqual([]);
});

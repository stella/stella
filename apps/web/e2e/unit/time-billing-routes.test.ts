import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { listTimeBillingRoutes } from "../helpers/time-billing-routes";

const routesFor = (options: string) => {
  const directory = mkdtempSync(path.join(tmpdir(), "route-gate-census-"));
  try {
    writeFileSync(
      path.join(directory, "feature.tsx"),
      `import { isTimeBillingEnabled as gate } from "@/hooks/use-time-billing-preview";
export const Route = createFileRoute("/feature")({ ${options} });`,
    );
    writeFileSync(
      path.join(directory, "child.tsx"),
      'export const Route = createFileRoute("/feature/child")({});',
    );
    return listTimeBillingRoutes(directory)
      .map(({ routePath }) => routePath)
      .toSorted();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test.each([
  "beforeLoad: () => { gate(); }",
  "beforeLoad: function () { gate(); }",
  "beforeLoad() { gate(); }",
  "async beforeLoad() { await gate(); }",
])("a direct gate in %s includes the route and its descendants", (options) => {
  expect(routesFor(options)).toEqual(["/feature", "/feature/child"]);
});

test.each([
  "beforeLoad() { const later = () => gate(); return later; }",
  "get beforeLoad() { gate(); return () => {}; }",
  "[hookName]() { gate(); }",
  "loader() { gate(); }",
])("%s does not establish a direct beforeLoad gate", (options) => {
  expect(() => routesFor(options)).toThrow(
    "Time-billing route lost its beforeLoad gate",
  );
});

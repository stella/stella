import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

/**
 * Census: every route that answers with a stored organization data export
 * (its row, parts, progress or a download link) decides through the owner
 * module `stored-export-access.ts`, and no other module reads stored exports
 * on a caller's behalf.
 */

const API_SRC = nodePath.resolve(import.meta.dir, "../..");
const OWNER_MODULE = "@/api/lib/data-export/stored-export-access";
const OWNER_CHECKS = [
  "readableStoredDataExports",
  "canReadStoredDataExport",
  "authorizeStoredDataExportRead",
  "authorizeStoredDataExportReplay",
] as const;

const read = (relative: string) =>
  readFileSync(nodePath.join(API_SRC, relative), "utf-8");

/** Source text with whitespace collapsed, so formatting does not matter. */
const flat = (relative: string) =>
  read(relative)
    .replaceAll(/\s+/gu, " ")
    .replaceAll("( ", "(")
    .replaceAll(", )", ")");

/** Route modules mounted by the data export routes table. */
const mountedRouteModules = () =>
  [
    ...read("handlers/data-exports/routes.ts").matchAll(
      /from "@\/api\/handlers\/data-exports\/([a-z-]+)"/gu,
    ),
  ]
    .map(([, name = ""]) => `handlers/data-exports/${name}.ts`)
    .toSorted();

/**
 * Modules outside tests that name the stored export table, with why each
 * may. A new reader fails the census until it is listed here.
 */
const STORED_EXPORT_READERS = {
  "db/schema/data-exports.ts": "the table definition",
  "handlers/data-exports/summary.ts":
    "the response projections the routes apply after the owner check",
  "handlers/data-exports/start-export.ts":
    "the create route's insert; its active-export answer is checked by the owner in create.ts",
  "handlers/data-exports/get.ts": "route: reads through the owner check",
  "handlers/data-exports/list.ts": "route: reads through the owner check",
  "handlers/data-exports/download.ts": "route: reads through the owner check",
  "handlers/data-exports/data-export-worker.ts":
    "the background worker that writes the export; answers no caller",
  "lib/data-export/stored-export-access.ts": "the owner",
  "lib/scheduler/tasks/data-export-maintenance.ts":
    "expiry and lost-worker maintenance; answers no caller",
  "lib/db/aggregate-lock.ts": "lock declarations",
  "lib/db/data-export-transition-spec.ts": "status transition declarations",
  "lib/db/transition-specs.ts": "status transition declarations",
  "lib/db/status-tables.gen.ts": "generated status table registry",
} as const satisfies Record<string, string>;

const sourceFiles = () =>
  [...new Bun.Glob("**/*.ts").scanSync(API_SRC)].filter(
    (file) =>
      !file.endsWith(".test.ts") &&
      !file.startsWith("tests/") &&
      !file.includes("__fixtures__"),
  );

describe("stored data export access census", () => {
  test("the routes table mounts exactly the audited routes", () => {
    expect(mountedRouteModules()).toEqual([
      "handlers/data-exports/create.ts",
      "handlers/data-exports/download.ts",
      "handlers/data-exports/get.ts",
      "handlers/data-exports/list.ts",
    ]);
  });

  test("every data export route decides through the owner", () => {
    for (const file of mountedRouteModules()) {
      const source = read(file);
      expect(source, file).toContain(`from "${OWNER_MODULE}"`);
      expect(
        OWNER_CHECKS.some((check) => source.includes(`${check}(`)) ||
          OWNER_CHECKS.some((check) => source.includes(`: ${check}`)),
        file,
      ).toBe(true);
    }
  });

  test("download and create check the stored export before a replay", () => {
    expect(flat("handlers/data-exports/download.ts")).toContain(
      "await authorizeStoredDataExportRead(context, context.params.exportId",
    );
    expect(flat("handlers/data-exports/create.ts")).toContain(
      "authorizeReplay: authorizeStoredDataExportReplay",
    );
  });

  test("only listed modules name the stored export table", () => {
    const readers = sourceFiles()
      .filter((file) => read(file).includes("organizationDataExports"))
      .toSorted();
    expect(readers).toEqual(Object.keys(STORED_EXPORT_READERS).toSorted());
  });
});

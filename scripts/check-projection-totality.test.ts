import { describe, expect, test } from "bun:test";

import {
  isResourceProjectionModule,
  shouldScanHandlerFile,
} from "./check-projection-totality";

describe("shouldScanHandlerFile", () => {
  test("scans ordinary handler source", () => {
    expect(
      shouldScanHandlerFile("apps/api/src/handlers/properties/list.ts"),
    ).toBe(true);
    expect(
      shouldScanHandlerFile("apps/api/src/handlers/skills/comments/list.ts"),
    ).toBe(true);
  });

  test("excludes the route table", () => {
    expect(shouldScanHandlerFile("apps/api/src/handlers/routes.ts")).toBe(
      false,
    );
  });

  test("excludes schema re-exports", () => {
    expect(shouldScanHandlerFile("apps/api/src/handlers/schema.ts")).toBe(
      false,
    );
    expect(
      shouldScanHandlerFile("apps/api/src/handlers/chat/schema-tools.ts"),
    ).toBe(false);
  });

  test("excludes test files, including integration and db suites", () => {
    expect(
      shouldScanHandlerFile("apps/api/src/handlers/skills/create.test.ts"),
    ).toBe(false);
    expect(
      shouldScanHandlerFile(
        "apps/api/src/handlers/docx-suggestions/read.db.test.ts",
      ),
    ).toBe(false);
    expect(
      shouldScanHandlerFile(
        "apps/api/src/handlers/chat/hydrate-messages.integration.test.ts",
      ),
    ).toBe(false);
  });

  test("excludes non-TypeScript files", () => {
    expect(
      shouldScanHandlerFile("apps/api/src/handlers/skills/README.md"),
    ).toBe(false);
  });
});

describe("isResourceProjectionModule", () => {
  test("classifies a row-typed list module by filename", () => {
    expect(
      isResourceProjectionModule({
        relativePath: "apps/api/src/handlers/properties/list.ts",
        content: "type PropertyRow = typeof properties.$inferSelect;",
      }),
    ).toBe(true);
  });

  test("classifies a non-list-named module that still declares $inferSelect", () => {
    expect(
      isResourceProjectionModule({
        relativePath: "apps/api/src/handlers/saved-searches/response.ts",
        content: "type SavedSearchRow = typeof savedSearches.$inferSelect;",
      }),
    ).toBe(true);
  });

  test("classifies a module reading via findMany or findFirst, named accordingly", () => {
    expect(
      isResourceProjectionModule({
        relativePath: "apps/api/src/handlers/playbooks/read.ts",
        content: "tx.query.playbookDefinitions.findFirst({ where: {} });",
      }),
    ).toBe(true);
    expect(
      isResourceProjectionModule({
        relativePath: "apps/api/src/handlers/workspaces/get.ts",
        content: "tx.query.workspaces.findMany({ where: {} });",
      }),
    ).toBe(true);
  });

  test("classifies a module reading via an inline .select({ ... })", () => {
    expect(
      isResourceProjectionModule({
        relativePath: "apps/api/src/handlers/contacts/list-query.ts",
        content: "tx.select({ id: contacts.id }).from(contacts);",
      }),
    ).toBe(true);
  });

  test("does not classify a module that reads rows but is not client-facing by name or $inferSelect", () => {
    expect(
      isResourceProjectionModule({
        relativePath: "apps/api/src/handlers/tasks/reconcile-cache.ts",
        content: "tx.query.tasks.findMany({ where: {} });",
      }),
    ).toBe(false);
  });

  test("does not classify a client-facing-named module that reads no schema rows", () => {
    expect(
      isResourceProjectionModule({
        relativePath: "apps/api/src/handlers/templates/list-cursor.ts",
        content: "export const decodeCursor = (cursor: string) => cursor;",
      }),
    ).toBe(false);
  });

  test("does not classify an unrelated helper with neither marker", () => {
    expect(
      isResourceProjectionModule({
        relativePath: "apps/api/src/handlers/chat/tools/registry-adapter.ts",
        content: "export const buildAdapter = () => ({});",
      }),
    ).toBe(false);
  });
});

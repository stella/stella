import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  collectResponseReachable,
  importSpecifiersOf,
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
        responseReachable: true,
      }),
    ).toBe(true);
  });

  test("classifies a handler whose operation is a basename suffix", () => {
    expect(
      isResourceProjectionModule({
        relativePath: "apps/api/src/handlers/rates/entries/list.ts",
        content: "const row = await tx.query.rateEntries.findFirst({});",
        responseReachable: true,
      }),
    ).toBe(true);
    expect(
      isResourceProjectionModule({
        relativePath:
          "apps/api/src/handlers/workspaces/workspace-contacts-read.ts",
        content:
          "const rows = await tx.select({ id: contacts.id }).from(contacts);",
        responseReachable: true,
      }),
    ).toBe(true);
  });

  test("classifies a non-list-named module that still declares $inferSelect", () => {
    expect(
      isResourceProjectionModule({
        relativePath: "apps/api/src/handlers/saved-searches/response.ts",
        content: "type SavedSearchRow = typeof savedSearches.$inferSelect;",
        responseReachable: true,
      }),
    ).toBe(true);
  });

  test("classifies a module reading via findMany or findFirst, named accordingly", () => {
    expect(
      isResourceProjectionModule({
        relativePath: "apps/api/src/handlers/playbooks/read.ts",
        content: "tx.query.playbookDefinitions.findFirst({ where: {} });",
        responseReachable: true,
      }),
    ).toBe(true);
    expect(
      isResourceProjectionModule({
        relativePath: "apps/api/src/handlers/workspaces/get.ts",
        content: "tx.query.workspaces.findMany({ where: {} });",
        responseReachable: true,
      }),
    ).toBe(true);
  });

  test("classifies a module reading via an inline .select({ ... })", () => {
    expect(
      isResourceProjectionModule({
        relativePath: "apps/api/src/handlers/contacts/list-query.ts",
        content: "tx.select({ id: contacts.id }).from(contacts);",
        responseReachable: true,
      }),
    ).toBe(true);
  });

  test("does not classify a module that reads rows but is not client-facing by name or $inferSelect", () => {
    expect(
      isResourceProjectionModule({
        relativePath: "apps/api/src/handlers/tasks/reconcile-cache.ts",
        content: "tx.query.tasks.findMany({ where: {} });",
        responseReachable: true,
      }),
    ).toBe(false);
  });

  test("does not classify a client-facing-named module that reads no schema rows", () => {
    expect(
      isResourceProjectionModule({
        relativePath: "apps/api/src/handlers/templates/list-cursor.ts",
        content: "export const decodeCursor = (cursor: string) => cursor;",
        responseReachable: true,
      }),
    ).toBe(false);
  });

  test("classifies a $inferSelect module that a response surface reaches", () => {
    expect(
      isResourceProjectionModule({
        relativePath: "apps/api/src/handlers/invoices/invoice-lines.ts",
        content: "type InvoiceLineRow = typeof invoiceLines.$inferSelect;",
        responseReachable: true,
      }),
    ).toBe(true);
  });

  test("does not classify a $inferSelect module that no response surface reaches", () => {
    expect(
      isResourceProjectionModule({
        relativePath:
          "apps/api/src/handlers/case-law/ingestion/worker-store.ts",
        content: "type ReceiptRow = typeof replayReceipts.$inferSelect;",
        responseReachable: false,
      }),
    ).toBe(false);
  });

  test("classifies a client-facing name whether or not a route reaches it", () => {
    expect(
      isResourceProjectionModule({
        relativePath: "apps/api/src/handlers/workspaces/get.ts",
        content: "tx.query.workspaces.findMany({ where: {} });",
        responseReachable: false,
      }),
    ).toBe(true);
  });

  test("does not classify an unrelated helper with neither marker", () => {
    expect(
      isResourceProjectionModule({
        relativePath: "apps/api/src/handlers/chat/tools/registry-adapter.ts",
        content: "export const buildAdapter = () => ({});",
        responseReachable: true,
      }),
    ).toBe(false);
  });
});

describe("importSpecifiersOf", () => {
  test("reads static, type, side-effect, re-export and dynamic imports", () => {
    expect(
      importSpecifiersOf(
        [
          'import { a } from "@/api/lib/a";',
          'import type { B } from "./b";',
          'import "@/api/lib/side-effect";',
          'export { c } from "../c";',
          'const d = await import("@/api/lib/d");',
        ].join("\n"),
      ),
    ).toEqual([
      "@/api/lib/a",
      "./b",
      "@/api/lib/side-effect",
      "../c",
      "@/api/lib/d",
    ]);
  });
});

describe("collectResponseReachable", () => {
  const apiRoot = path.resolve(import.meta.dir, "../apps/api/src");
  const apiFiles = Array.from(
    new Bun.Glob("**/*.ts").scanSync({ cwd: apiRoot, absolute: true }),
  );
  const reachable = collectResponseReachable(apiFiles);

  test("reaches a guarded projection helper through its route", () => {
    expect(
      reachable.has(path.join(apiRoot, "handlers/invoices/invoice-lines.ts")),
    ).toBe(true);
  });

  test("does not reach the replay worker's internal store", () => {
    expect(
      reachable.has(
        path.join(
          apiRoot,
          "handlers/case-law/ingestion/background-replay-store.ts",
        ),
      ),
    ).toBe(false);
  });
});
